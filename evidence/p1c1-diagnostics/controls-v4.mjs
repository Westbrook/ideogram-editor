import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const source=process.cwd(), out=resolve(source,'..'), engine=process.argv[2]||'chromium', only=process.argv[3]||'';
const {chromium,webkit,firefox}=await import(pathToFileURL(resolve('node_modules/playwright/index.mjs')));
const {startLocalServer}=await import(pathToFileURL(resolve('dist/local/server/http.js')));
const {ownedOPFS}=await import(pathToFileURL(resolve('tests/editor/owned-opfs.ts')));
const root=await mkdtemp(resolve(await realpath(tmpdir()),'ie-review-text-'));
const server=await startLocalServer({root:resolve(root,'private'),staticDirectory:resolve('artifacts/p1c1/app')});
const browser=await ({chromium,webkit,firefox}[engine]).launch();
const context=await browser.newContext();
const page=await context.newPage();
const receipt={selection:only||'all',engine,version:browser.version(),origin:server.origin,start:new Date().toISOString(),checks:[],workers:[],requests:[],errors:[]};
page.on('request',r=>receipt.requests.push({url:r.url(),type:r.resourceType()}));
page.on('pageerror',e=>receipt.errors.push(String(e)));
page.on('worker',w=>{const row={url:w.url(),closed:false};receipt.workers.push(row);w.on('close',()=>row.closed=true)});
async function check(name,operation,verify) {
 if(only&&!name.includes(only))return;
 let result;
 try {result=await operation();verify(result);receipt.checks.push({name,status:'PASS',result});}
 catch(e){receipt.checks.push({name,status:'FAIL',result,error:String(e),stack:e.stack});}
}
try{
 const response=await page.goto(server.origin);await page.waitForFunction(()=>!!window.textFixture);
 await check('lazy fixture and unchanged page policy',async()=>({csp:response.headers()['content-security-policy'],early:[...receipt.requests]}),r=>{
  assert(!r.csp.includes('wasm-unsafe-eval'));assert(!r.csp.includes("'unsafe-eval'"));assert(!r.early.some(x=>/\.wasm|\.ttf|\.otf|worker-/.test(x.url)));
 });
 await check('native complete Unicode control and line geometry',async()=>await page.evaluate(async()=>{
  const f=window.textFixture,rows=[];
  for(const text of ['\n',' \n\n','A\u200bB','A\u2067مرحبا\u2069B']){
   const q=await f.request(text,['NotoSans','NotoSansArabic']);
   try{const p=await f.renderer.prepare(q);rows.push({text,retained:await p.textUtf8.text(),layout:JSON.parse(await p.layout.text()),rasterHash:p.rasterHash});f.releasePrepared(p);}
   catch(e){rows.push({text,error:e.code,details:e.details});}
  }
  return rows;
 }),rows=>{
  for(const r of rows){assert(!r.error,JSON.stringify(r));assert.equal(r.retained,r.text);assert.equal(r.layout.logicalLines,r.text.split('\n').length);
   assert.equal(r.layout.paragraphs.length,r.text.split('\n').length);
   let i=0,b=0;for(const c of r.text){assert.equal(r.layout.utf16ToUtf8[i],b);assert.equal(r.layout.utf8ToUtf16[b],i);i+=c.length;b+=new TextEncoder().encode(c).length;}
   assert.equal(r.layout.utf16ToUtf8[i],b);
  }
 });
 await check('missing-glyph diagnostics name only affected codepoints',async()=>await page.evaluate(async()=>{
  const f=window.textFixture,rows=[];
  for(const text of ['AB','\t','A\tB']){
   const q=await f.request(text,['NotoSans','NotoSansArabic']);
   try{const p=await f.renderer.prepare(q);rows.push({text,retained:await p.textUtf8.text(),fonts:p.dependencies.map(d=>d.hash)});f.releasePrepared(p)}
   catch(e){rows.push({text,error:e.code,details:e.details})}
  }return rows;
 }),rows=>{
  assert.equal(rows[0].retained,'AB');
  if(rows[2].retained!==undefined){assert.equal(rows[2].retained,'A\tB')}else{
   assert.equal(rows[2].error,'TEXT_MISSING_GLYPHS');
   assert(!rows[2].details.codepoints.some(cp=>cp===65||cp===66), 'A and B rendered by the same exact fonts must not be named as missing; actual '+JSON.stringify(rows[2].details.codepoints));
  }
 });
 await check('native physical and logical alignment',async()=>await page.evaluate(async()=>{
  const f=window.textFixture,rows=[];
  for(const direction of ['ltr','rtl'])for(const align of ['left','center','right','start','end']){
   const q=await f.request('AB'),p=await f.renderer.prepare({...q,frame:{width:160,height:100},style:{...q.style,direction,align}});
   const l=JSON.parse(await p.layout.text());rows.push({direction,align,left:l.paragraphs[0].lines[0].left,width:l.paragraphs[0].lines[0].width,hash:p.rasterHash});f.releasePrepared(p);
  }return rows;
 }),rows=>{
  for(const dir of ['ltr','rtl']){const get=a=>rows.find(r=>r.direction===dir&&r.align===a);
   assert(get('left').left<get('center').left&&get('center').left<get('right').left);
   assert.equal(get('start').hash,get(dir==='ltr'?'left':'right').hash);
   assert.equal(get('end').hash,get(dir==='ltr'?'right':'left').hash);
  }
 });
 await check('caller fonts and output survive private disposal, duplicate release is inert',async()=>await page.evaluate(async()=>{
  const f=window.textFixture;f.renderer.dispose();
  const q=await f.request('retained local input'),base=q.fonts[0],bytes=new Blob([await base.bytes.arrayBuffer()]);
  const local={...q,fonts:[{...base,bytes,origin:'local-file'}]};
  const before=f.textMemory.snapshot,r=new f.TextRenderer(),p=await r.prepare(local);
  const hash=await f.hashBytes(p.rgba),live=f.textMemory.snapshot; r.dispose();const disposed=f.textMemory.snapshot;r.dispose();
  const twice=f.textMemory.snapshot,expected=p.rgba.size+p.layout.size+p.textUtf8.size+bytes.size;
  const afterHash=await f.hashBytes(p.rgba);f.releasePrepared(p);f.releasePrepared(p);
  return {before,live,disposed,twice,expected,after:f.textMemory.snapshot,hash,afterHash,life:r.lifecycle,inputHash:await f.hashBytes(bytes),expectedFont:base.hash};
 }),r=>{
  assert.equal(r.hash,r.afterHash);assert.equal(r.inputHash,r.expectedFont);
  assert.equal(r.disposed.textBytes-r.before.textBytes,r.expected);assert.deepEqual(r.disposed,r.twice);assert.deepEqual(r.after,r.before);assert.equal(r.life.uncertainBytes,0);
 });
 await check('active supersession and same-turn coalescing keep latest authority',async()=>await page.evaluate(async()=>{
  const f=window.textFixture,q=await f.request('original'),r=new f.TextRenderer(),before=f.textMemory.snapshot;
  const warm=await r.prepare(q);f.releasePrepared(warm);
  const a=r.prepare({...q,text:'obsolete one',token:{...q.token,generation:11}}).then(()=>({accepted:true}),e=>({code:e.code}));
  await Promise.resolve();
  const b=r.prepare({...q,text:'obsolete two',token:{...q.token,generation:12}}).then(()=>({accepted:true}),e=>({code:e.code}));
  const c=await r.prepare({...q,text:'latest native',token:{...q.token,generation:13}});
  const row={a:await a,b:await b,text:await c.textUtf8.text(),generation:c.token.generation,life:r.lifecycle};
  f.releasePrepared(c);r.dispose();return {...row,before,after:f.textMemory.snapshot};
 }),r=>{assert.equal(r.a.code,'TEXT_STALE');assert.equal(r.b.code,'TEXT_STALE');assert.equal(r.text,'latest native');assert.equal(r.generation,13);assert.equal(r.life.queuedRequests,0);assert.deepEqual(r.after,r.before)});
 await check('invalid preallocation leaves caller and competing leases intact',async()=>await page.evaluate(async()=>{
  const f=window.textFixture,q=await f.request('untouched'),r=new f.TextRenderer(),before=f.textMemory.snapshot;
  const other=f.textMemory.reserve(500*1024**2,'other'),booked=f.textMemory.snapshot;
  const code=await r.prepare(q).then(()=> 'accepted',e=>e.code),during=f.textMemory.snapshot,life=r.lifecycle;
  other.release();other.release();r.dispose();return{code,before,booked,during,after:f.textMemory.snapshot,life,text:q.text};
 }),r=>{assert.equal(r.code,'TEXT_MEMORY_BUDGET');assert.deepEqual(r.booked,r.during);assert.deepEqual(r.before,r.after);assert.equal(r.life.activeWorkers+r.life.idleWorkers,0);assert.equal(r.text,'untouched')});
 await check('native cache retry preserves original deadline under deterministic clock advance',async()=>await page.evaluate(async()=>{
  const f=window.textFixture,q=await f.request('deadline cache'),base=q.fonts[0],r=new f.TextRenderer(),rows=[];
  const NativeWorker=window.Worker,now=performance.now.bind(performance),nativeTimeout=window.setTimeout;
  let shift=0,armed=false;const events=[],timers=[],created=[];
  Object.defineProperty(performance,'now',{configurable:true,value:()=>now()+shift});
  window.setTimeout=function(handler,delay,...args){if(armed)timers.push(delay);return nativeTimeout.call(this,handler,delay,...args)};
  window.Worker=class extends NativeWorker{constructor(...args){super(...args);created.push(String(args[0]));this.addEventListener('message',event=>{
   if(armed&&event.data.code==='FONT_CACHE_CAPACITY'){events.push({code:event.data.code,at:now()});shift+=20001;}
  })}};
  try{
   for(let i=0;i<16;i++){const bytes=new Blob([base.bytes,new Uint8Array([i+21])]),hash=await f.hashBytes(bytes);
    const p=await r.prepare({...q,fonts:[{...base,bytes,hash,origin:'local-file'}],style:{...q.style,primaryFont:hash}});
    rows.push(p.dependencies[0].hash===hash);f.releasePrepared(p);
   }
   armed=true;const bytes=new Blob([base.bytes,new Uint8Array([99])]),hash=await f.hashBytes(bytes);
   const code=await r.prepare({...q,fonts:[{...base,bytes,hash,origin:'local-file'}],style:{...q.style,primaryFont:hash}}).then(p=>{f.releasePrepared(p);return 'accepted'},e=>e.code);
   return{rows,code,events,timers,created,life:r.lifecycle,scope:'Real native font/cache/worker operations; performance.now advanced only at actual native cache-capacity result. Functional deadline, no elapsed-performance claim.'};
  }finally{r.dispose();window.Worker=NativeWorker;window.setTimeout=nativeTimeout;delete performance.now}
 }),r=>{assert(r.rows.every(Boolean));assert.equal(r.code,'TEXT_DEADLINE');assert.equal(r.events.length,1);assert.equal(r.created.length,2);assert.equal(r.timers.length,1);assert.equal(r.life.terminations,2)});
 await page.close();
 assert(receipt.requests.every(r=>new URL(r.url).origin===server.origin));
 await check('controlled-origin fixture refuses unadmitted native state with zero reset',async()=>{
  const c=await browser.newContext(),storage=await ownedOPFS(c,engine+' reviewer refusal'),p=await c.newPage();
  let error='';try{await p.goto(server.origin).catch(()=>{});await storage.cleanup()}catch(e){error=String(e)}
  const row={error,ledger:storage.ledger};await c.close();return row;
 },r=>{assert(r.error.includes('OPFS_RESET_REFUSED'));assert.equal(r.ledger.filter(x=>x.phase==='public-reset').length,0)});
}finally{
 await context.close();await browser.close();await server.close();await rm(root,{recursive:true});
 receipt.end=new Date().toISOString();await writeFile(resolve(out,'controls-v4-'+engine+(only?'-focused':'')+'.json'),JSON.stringify(receipt,null,2));
 console.log(JSON.stringify({engine,checks:receipt.checks.map(({name,status,error})=>({name,status,error})),errors:receipt.errors,workers:receipt.workers},null,2));
}
if(receipt.checks.some(c=>c.status!=='PASS')||receipt.errors.length)process.exitCode=1;

import { test as base, expect } from '@playwright/test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ownedOPFS } from '../editor/owned-opfs';
const test=base.extend<{nativeErrors:void; initialRequests:string[]}>({initialRequests:async({context},use)=>{const requests:string[]=[];context.on('request',r=>requests.push(r.url()));await use(requests);},nativeErrors:[async({context},use,info)=>{
  const errors:{kind:string;message:string}[]=[];
  context.on('weberror',e=>errors.push({kind:'pageerror',message:e.error().message}));
  context.on('console',m=>{if(m.type()==='error')errors.push({kind:'console',message:m.text()});});
  try{await use();}finally{
    await info.attach('native-errors',{body:JSON.stringify(errors),contentType:'application/json'});
    expect(errors).toEqual([]);
  }
},{auto:true}]});
const {startLocalServer}=await import(pathToFileURL(resolve('dist/local/server/http.js')).href);
let server: Awaited<ReturnType<typeof startLocalServer>>, origin: string, root: string;
test.beforeAll(async () => {
  root=await mkdtemp(resolve(await realpath(tmpdir()),'ie-text-host-'));
  server=await startLocalServer({root:resolve(root,'private'),staticDirectory:resolve(process.env.TEXT_APP??'artifacts/p1c1/app')});
  origin=server.origin;
});
test.afterAll(async()=>{await server?.close();if(root)await rm(root,{recursive:true});});
test.describe(()=>{
test.beforeEach(async({page,initialRequests},info)=>{
  const response=await page.goto(origin);
  expect(response!.headers()['content-security-policy']).not.toContain('wasm-unsafe-eval');
  await page.waitForFunction(()=>!!(window as any).textFixture);
});

test('real worker Latin, combining, ligature and supplementary mapping', async ({page,initialRequests}, info) => {
  const errors:string[] = [], network:string[] = initialRequests;
  page.on('pageerror',e=>errors.push(e.message));
  expect(network.some(u=>/wasm|\.ttf|\.otf|worker-/.test(u))).toBe(false);
  const result = await page.evaluate(()=> (window as any).textFixture.render('office A\u0301 🂡', ['NotoSans','NotoSansSymbols2']));
  expect(result.textUtf8).toBe('office A\u0301 🂡'); expect(result.frozen).toBe(true);
  expect(result.layout.utf16ToUtf8).toEqual([0,1,2,3,4,5,6,7,8,10,11,-1,15]);
  expect(result.layout.utf8ToUtf16).toEqual([0,1,2,3,4,5,6,7,8,-1,9,10,-1,-1,-1,12]);
  expect(result.layout.paragraphs[0].clusters.some((c:any)=>c.startUtf16===7&&c.endUtf16===9)).toBe(true);
  expect(result.layout.paragraphs[0].clusters.some((c:any)=>c.startUtf16===10&&c.endUtf16===12)).toBe(true);
  expect(result.layout.paragraphs[0].runs.reduce((n:number,r:any)=>n+r.glyphs.length,0)).toBeLessThan(11);
  expect(result.rgba.some((v:number,i:number)=>i%4===3&&v>0)).toBe(true);
  expect(result.lifecycle.activeWorkers).toBe(0);expect(errors).toEqual([]);
  expect(network.every(u=>new URL(u).origin===origin)).toBe(true);
  await info.attach('native-layout',{body:JSON.stringify({...result,rgba:undefined}),contentType:'application/json'});
});

test('real worker RTL per paragraph, bidi runs, CJK and exact retained bytes',async({page},info)=>{
  const result=await page.evaluate(async()=>{
    const f=(window as any).textFixture; const a=await f.render('مرحبا ABC 123\n中文日本語', ['NotoSans','NotoSansArabic','NotoSansCJKsc']).catch((e:any)=>{throw Error('CJK '+String(e));});
    const b=await f.render('مرحبا ABC 123\n中文日本語', ['NotoSans','NotoSansArabic','NotoSansCJKsc']).catch((e:any)=>{throw Error('CJK repeated '+String(e));});
    const onlyLatin=await f.request('中文', ['NotoSans']);
    const cachedFontRefusal=await f.renderer.prepare(onlyLatin).then(()=> 'unexpected',(e:any)=>e.code);
    await f.render('cache eviction control', ['NotoSans']);
    const c=await f.render('مرحبا ABC 123\n中文日本語', ['NotoSans','NotoSansArabic','NotoSansCJKsc']);
    return {...a,cachedFontRefusal,evictedRaster:c.rasterHash,reservations:f.textMemory.snapshot,repeatedRaster:b.rasterHash,repeatedLayout:b.layoutHash,repeatedDependency:b.dependencyHash};
  });
  expect(result.evictedRaster).toBe(result.rasterHash);expect(result.reservations.textBytes).toBeLessThanOrEqual(128*1024**2);
  expect(['TEXT_MISSING_GLYPHS','TEXT_UNRESOLVED_RUN_FONT']).toContain(result.cachedFontRefusal);
  expect(result.repeatedRaster).toBe(result.rasterHash);expect(result.repeatedLayout).toBe(result.layoutHash);
  expect(result.repeatedDependency).toBe(result.dependencyHash);
  const [rtl,cjk]=result.layout.paragraphs;
  expect([rtl.direction,cjk.direction]).toEqual(['rtl','ltr']);
  expect(rtl.clusters[0].rect[0]).toBeGreaterThan(rtl.clusters[4].rect[0]);
  expect(rtl.clusters.slice(6,9).map((c:any)=>c.direction)).toEqual(['ltr','ltr','ltr']);
  expect(rtl.runs.flatMap((r:any)=>r.offsetsUtf8)).toContain(8);
  expect(cjk.startUtf16).toBe(14);expect(cjk.startUtf8).toBe(19);
  expect(cjk.clusters.map((c:any)=>[c.startUtf16,c.endUtf16,c.startUtf8,c.endUtf8])).toEqual([[14,15,19,22],[15,16,22,25],[16,17,25,28],[17,18,28,31],[18,19,31,34]]);
  expect(new Set(result.layout.paragraphs.flatMap((p:any)=>p.runs.map((r:any)=>r.fontHash))).size).toBe(3);
  expect(result.allocation.gpuBytes).toBe(0);expect(result.allocation.wasmHeapBytes).toBeLessThanOrEqual(128*1024**2);
  await info.attach('layout',{body:JSON.stringify({...result,rgba:undefined}),contentType:'application/json'});
});

test('CPU straight alpha, fractional clip, wrapping, empty text and explicit direction',async({page},info)=>{
  const output=await page.evaluate(async()=>{
    const f=(window as any).textFixture;
    async function draw(changes:any){const q=await f.request('MMMM\nMMMM');Object.assign(q,changes);const p=await f.renderer.prepare(q);return{hash:p.rasterHash,width:p.width,height:p.height,overflow:p.overflow,layout:JSON.parse(await p.layout.text()),pixels:Array.from(new Uint8Array(await p.rgba.arrayBuffer()))};}
    const q=await f.request('MMMM\nMMMM');
    const full=await draw({frame:{width:120,height:160}}),half=await draw({frame:{width:120,height:160},style:{...q.style,fill:[40,90,190,128]}});
    const clipped=await draw({frame:{width:120,height:20.5}}),zero=await draw({style:{...q.style,fill:[255,180,90,0]}});
    const empty=await draw({text:''}),wrap=await draw({frame:{width:40,height:300}}),rtl=await draw({text:'ABC',style:{...q.style,direction:'rtl'}});
    return{full,half,clipped,zero,empty,wrap,rtl};
  });
  const {full,half,clipped,zero,empty,wrap,rtl}=output;
  expect(full.overflow).toBe(false);expect(clipped.overflow).toBe(true);expect([clipped.width,clipped.height]).toEqual([120,21]);
  let opaque=0;
  for(let i=0;i<full.pixels.length;i+=4){
    if(full.pixels[i+3]===255){expect(full.pixels.slice(i,i+4)).toEqual([40,90,190,255]);expect(half.pixels.slice(i,i+4)).toEqual([40,90,190,128]);opaque++;}
    if(full.pixels[i+3]===0)expect(full.pixels.slice(i,i+4)).toEqual([0,0,0,0]);
  }
  expect(opaque).toBeGreaterThan(0);expect(zero.pixels.every((v:number)=>v===0)).toBe(true);expect(empty.pixels.every((v:number)=>v===0)).toBe(true);
  expect(full.layout.requestedLineHeight).toBeCloseTo(full.layout.intrinsicHeight*1.2,6);
  expect(empty.layout.paragraphs).toHaveLength(1);expect(wrap.layout.paragraphs[0].lines.length).toBeGreaterThan(1);
  expect(wrap.layout.logicalLines).toBe(2);expect(rtl.layout.paragraphs[0].direction).toBe('rtl');
  let fractional=false;
  for(let x=0;x<120;x++){const i=(20*120+x)*4;if(full.pixels[i+3]===255&&clipped.pixels[i+3]>0&&clipped.pixels[i+3]<255)fractional=true;}
  expect(fractional).toBe(true);
  await info.attach('pixel-controls',{body:JSON.stringify(Object.fromEntries(Object.entries(output).map(([k,v]:[string,any])=>[k,{...v,pixels:undefined}]))),contentType:'application/json'});
});

test('missing diagnostics identify native affected spans without blaming supported clusters',async({page},info)=>{
  const result=await page.evaluate(async()=>{
    const f=(window as any).textFixture, fonts=['NotoSans','NotoSansArabic','NotoSansSymbols2'];
    const saved=await f.renderer.prepare(await f.request('office A\u0301 🂡 مرحبا',fonts));
    const beforeHash=await f.hashBytes(saved.rgba), rows=[];
    for(const [text,expected] of [
      ['A\tB',[9]], ['A\tB\tC',[9]], ['A\u0301🂡\tB',[9]],
      ['مرحبا\tعالم',[9]], ['AB\n🂡A\u0301\tB',[9]],
      ['A\u0301🂡𝄞B',[0x1d11e]], ['A中🂡文B',[0x4e2d,0x6587]],
    ] as [string,number[]][]){
      const request=await f.request(text,fonts);
      try{const p=await f.renderer.prepare(request);rows.push({text,expected,accepted:true});f.releasePrepared(p);}
      catch(e:any){rows.push({text,expected,code:e.code,details:e.details,unchanged:request.text===text});}
    }
    // Native handling of standalone/control/format text is preserved; these
    // checks do not invent a tab width or require standalone TAB refusal.
    const controls=[];
    for(const text of ['AB','\t','A\u200bB','A\u2067مرحبا\u2069B']){
      const p=await f.renderer.prepare(await f.request(text,fonts));
      controls.push({text,retained:await p.textUtf8.text()});f.releasePrepared(p);
    }
    const afterHash=await f.hashBytes(saved.rgba);f.releasePrepared(saved);f.renderer.dispose();
    return{rows,controls,beforeHash,afterHash};
  });
  await info.attach('affected-codepoint-diagnostics',{body:JSON.stringify(result),contentType:'application/json'});
  expect(result.afterHash).toBe(result.beforeHash);
  for(const row of result.rows){
    expect(row.code,row.text).toBe('TEXT_MISSING_GLYPHS');expect(row.details.codepoints,row.text).toEqual(row.expected);
    expect(row.unchanged).toBe(true);
    if(row.text.includes('\t')){
      const ranges=[];
      for(let i=0;i<row.text.length;i++)if(row.text[i]==='\t')ranges.push({startUtf16:i,endUtf16:i+1,
        startUtf8:new TextEncoder().encode(row.text.slice(0,i)).length,endUtf8:new TextEncoder().encode(row.text.slice(0,i+1)).length});
      expect(row.details.ranges,row.text).toEqual(ranges);
    }
  }
  for(const row of result.controls)expect(row.retained).toBe(row.text);
});

test('missing, corrupt, restricted, unreviewed and hash-mismatched fonts refuse preparation',async({page},info)=>{
  const results=await page.evaluate(async()=>{
    const f=(window as any).textFixture, base=await f.request('ABC'), results:any={};
    async function check(key:string,q:any){try{await f.renderer.prepare(q);results[key]={accepted:true};}catch(e:any){results[key]={code:e.code,details:e.details};}}
    await check('missingGlyph',{...base,text:'𝄞'});
    await check('missingFont',{...base,fonts:[]});
    await check('hashMismatch',{...base,fonts:[{...base.fonts[0],bytes:new Blob(['bad'])}]});
    await check('unreviewed',{...base,fonts:[{...base.fonts[0],license:{hash:base.fonts[0].license.hash,embedding:'unknown'}}]});
    await check('faceIndex',{...base,fonts:[{...base.fonts[0],faceIndex:1}]});
    await check('unlistedFallback',{...base,style:{...base.style,explicitFallbacks:[base.fonts[0].hash]}});
    async function mutated(key:string,mutate:(b:ArrayBuffer)=>void){const b=await base.fonts[0].bytes.arrayBuffer();mutate(b);const bytes=new Blob([b]),hash=await f.hashBytes(bytes);await check(key,{...base,fonts:[{...base.fonts[0],bytes,hash}],style:{...base.style,primaryFont:hash}});}
    await mutated('corrupt',b=>new Uint8Array(b)[b.byteLength-12]^=1);
    await mutated('tableBounds',b=>new DataView(b).setUint32(20,b.byteLength+4));
    await mutated('collection',b=>new DataView(b).setUint32(0,0x74746366));
    await mutated('variable',b=>new Uint8Array(b).set([102,118,97,114],12));
    await mutated('restricted',b=>{
      const v=new DataView(b),u=new Uint8Array(b);
      for(let i=0;i<v.getUint16(4);i++){const at=12+i*16;if(String.fromCharCode(...u.slice(at,at+4))!=='OS/2')continue;
        const start=v.getUint32(at+8),length=v.getUint32(at+12);v.setUint16(start+8,2);let sum=0;
        for(let j=0;j<length;j+=4){let word=0;for(let k=0;k<4;k++)word=word*256+(j+k<length?u[start+j+k]:0);sum=(sum+word)>>>0;}v.setUint32(at+4,sum);
      }
    });
    return results;
  });
  expect(results.missingGlyph).toEqual({code:'TEXT_MISSING_GLYPHS',details:{codepoints:[0x1d11e]}});
  expect(results.missingFont.code).toBe('FONT_ORDER');expect(results.hashMismatch.code).toBe('FONT_HASH');
  expect(results.unreviewed.code).toBe('FONT_EMBEDDING_UNKNOWN');expect(results.faceIndex.code).toBe('FONT_FACE_INDEX');
  expect(results.unlistedFallback.code).toBe('FONT_ORDER');expect(results.corrupt.code).toBe('FONT_TABLE_CHECKSUM');
  expect(results.tableBounds.code).toBe('FONT_TABLE_BOUNDS');expect(results.restricted.code).toBe('FONT_EMBEDDING_RESTRICTED');
  expect(results.collection.code).toBe('FONT_STATIC_SFNT_REQUIRED');expect(results.variable.code).toBe('FONT_UNSUPPORTED_TABLE');
  await info.attach('refusals',{body:JSON.stringify(results),contentType:'application/json'});
});

test('exact admission boundaries preserve input and reject unsafe indices and geometry',async({page})=>{
  const result=await page.evaluate(async()=>{
    const f=(window as any).textFixture,q=await f.request('a'),cases:any={};
    for(const [name,text] of Object.entries({bytesAt:'x'.repeat(16384),bytesOver:'x'.repeat(16385),utf8At:'é'.repeat(8192),utf8Over:'é'.repeat(8193),linesAt:'\n'.repeat(255),linesOver:'\n'.repeat(256),surrogate:'\ud800',crlf:'a\r\nb',combining:'A\u0301'})){
      try{const i=f.textIndices(text);cases[name]={bytes:i.bytes,lines:i.lines};}catch(e:any){cases[name]=e.code;}
    }
    for(const [name,frame] of Object.entries({zero:{width:0,height:1},infinite:{width:Infinity,height:1},pixelsOver:{width:5000,height:5001},pixelsAt:{width:5000,height:5000}})){
      try{f.admitRequest({...q,frame});cases[name]='accepted';}catch(e:any){cases[name]=e.code;}
    }
    const font=q.fonts[0];
    for(const [name,fonts] of Object.entries({faceOver:[{...font,bytes:new Blob([new Uint8Array(16777217)])}],facesOver:Array.from({length:17},(_,i)=>({...font,hash:'sha256:'+i.toString(16).padStart(64,'0')}))})){
      try{f.admitRequest({...q,fonts,style:{...q.style,primaryFont:fonts[0].hash,explicitFallbacks:fonts.slice(1).map((x:any)=>x.hash)}});cases[name]='accepted';}catch(e:any){cases[name]=e.code;}
    }
    const maximum=new Blob([new Uint8Array(16777216)]),small=new Blob(['x']);
    for(const [name,blobs] of Object.entries({faceAt:[maximum],setAt:[maximum,maximum,maximum,maximum],setOver:[maximum,maximum,maximum,maximum,small],facesAt:Array(16).fill(small)})){
      const fonts=blobs.map((bytes:any,i:number)=>({...font,bytes,hash:'sha256:'+i.toString(16).padStart(64,'0')}));
      try{f.admitRequest({...q,fonts,style:{...q.style,primaryFont:fonts[0].hash,explicitFallbacks:fonts.slice(1).map((x:any)=>x.hash)}});cases[name]='accepted';}catch(e:any){cases[name]=e.code;}
    }
    cases.directions=['123 مرحبا','ABC مرحبا','\u2067مرحبا\u2069 ABC','123'].map(f.paragraphDirection);
    return cases;
  });
  expect(result.bytesAt.bytes).toBe(16384);expect(result.bytesOver).toBe('TEXT_BYTES');expect(result.utf8At.bytes).toBe(16384);expect(result.utf8Over).toBe('TEXT_BYTES');
  expect(result.linesAt.lines).toBe(256);expect(result.linesOver).toBe('TEXT_LINES');expect(result.surrogate).toBe('TEXT_SURROGATE');expect(result.crlf).toBe('TEXT_REQUIRES_REVIEWED_LF_CONVERSION');
  expect(result.combining.bytes).toBe(3);expect(result.pixelsAt).toBe('accepted');
  for(const k of ['zero','infinite','pixelsOver'])expect(result[k]).toBe('TEXT_FRAME');
  expect(result.faceOver).toBe('FONT_SIZE');expect(result.facesOver).toBe('FONT_ORDER');
  for(const key of ['faceAt','setAt','facesAt'])expect(result[key]).toBe('accepted');expect(result.setOver).toBe('FONT_SET_SIZE');
  expect(result.directions).toEqual(['rtl','ltr','ltr','ltr']);
});

test('latest preview queue coalesces obsolete requests and releases disposal exactly once',async({page},info)=>{
  const workers:string[]=[];page.on('worker',w=>workers.push(w.url()));
  const result=await page.evaluate(async()=>{
    const f=(window as any).textFixture,q=await f.request('first'),before=f.textMemory.snapshot;
    const first=f.renderer.prepare(q).then(()=> 'unexpected',(e:any)=>e.code);
    const second=f.renderer.prepare({...q,text:'second',token:{...q.token,generation:2}}).then(()=> 'unexpected',(e:any)=>e.code);
    const latest=await f.renderer.prepare({...q,text:'latest',token:{...q.token,generation:3}});
    const firstResult=await first,secondResult=await second,text=await latest.textUtf8.text(),generation=latest.token.generation;
    const retained=f.textMemory.snapshot;
    f.renderer.dispose();const disposed=f.textMemory.snapshot;f.renderer.dispose();const twice=f.textMemory.snapshot;
    f.releasePrepared(latest);f.releasePrepared(latest);const released=f.textMemory.snapshot;
    let after='';try{await f.renderer.prepare(q);}catch(e:any){after=e.code;}
    return{firstResult,secondResult,text,generation,after,before,retained,disposed,twice,released,lifecycle:f.renderer.lifecycle};
  });
  expect(result.firstResult).toBe('TEXT_STALE');expect(result.secondResult).toBe('TEXT_STALE');expect(result.text).toBe('latest');expect(result.generation).toBe(3);
  expect(result.after).toBe('TEXT_DISPOSED');expect(result.lifecycle.activeWorkers).toBe(0);expect(result.lifecycle.uncertainBytes).toBe(0);
  expect(workers).toHaveLength(1);expect(result.disposed).toEqual(result.twice);expect(result.released).toEqual(result.before);
  expect(result.disposed.textBytes).toBeGreaterThan(result.before.textBytes);
  await info.attach('coalescing-disposal',{body:JSON.stringify({result,workers,resetCalls:0}),contentType:'application/json'});
});

test('pinned WASM allocator refuses growth above the explicit worker heap cap',async({page},info)=>{
  const result=await page.evaluate(()=>(window as any).textFixture.heapControl());
  expect(result.error).toBeUndefined();expect(result.pointer).toBeGreaterThan(0);
  expect(result.overPointer).toBe(0);expect(result.final).toBeLessThanOrEqual(32*1024**2);
  expect(result.before).toBe(16*1024**2);expect(result.after).toBeGreaterThan(result.before);
  expect(result.denied).toBeNull();expect(result.deniedRects).toBeNull();expect(result.glyphs).toBeGreaterThan(0);
  expect(result.emptyRects).toHaveLength(0);
  await info.attach('heap-admission',{body:JSON.stringify(result),contentType:'application/json'});
});

test('historical native font cache occupancy triggers a bounded cold recycle',async({page},info)=>{
  const result=await page.evaluate(async()=>{
    const f=(window as any).textFixture,q=await f.request('cache test'),base=q.fonts[0],before=f.textMemory.snapshot;
    const hashes=[];
    for(let i=0;i<17;i++){
      // Identical valid sfnt tables with distinct unused trailing padding.
      const bytes=new Blob([base.bytes,new Uint8Array([i+1])]),hash=await f.hashBytes(bytes);
      const value=await f.renderer.prepare({...q,fonts:[{...base,bytes,hash,origin:'local-file'}],style:{...q.style,primaryFont:hash}});
      hashes.push(value.rasterHash);f.releasePrepared(value);
    }
    const lifecycle=f.renderer.lifecycle;f.renderer.dispose();
    return{hashes,before,after:f.textMemory.snapshot,lifecycle};
  });
  expect(new Set(result.hashes).size).toBe(1);expect(result.hashes).toHaveLength(17);
  expect(result.lifecycle.terminations).toBe(1);expect(result.after).toEqual(result.before);
  await info.attach('cache-recycle',{body:JSON.stringify(result),contentType:'application/json'});
});

test('native font allocation pressure recycles once without substituting current font bytes',async({page},info)=>{
  const result=await page.evaluate(async()=>{
    const f=(window as any).textFixture,q=await f.request('中文',['NotoSansCJKsc'],{frame:{width:100,height:80}}),base=q.fonts[0],hashes=[];
    for(let i=0;i<2;i++){
      const bytes=new Blob([base.bytes,new Uint8Array([i+1])]),hash=await f.hashBytes(bytes);
      const value=await f.renderer.prepare({...q,fonts:[{...base,bytes,hash,origin:'local-file'}],style:{...q.style,primaryFont:hash}});
      hashes.push({raster:value.rasterHash,expectedFont:hash,actualFont:value.dependencies[0].hash});f.releasePrepared(value);
    }
    const lifecycle=f.renderer.lifecycle;f.renderer.dispose();return{hashes,lifecycle};
  });
  expect(result.hashes[0].raster).toBe(result.hashes[1].raster);
  for(const row of result.hashes)expect(row.actualFont).toBe(row.expectedFont);
  expect(result.lifecycle.terminations).toBe(1);
  await info.attach('native-capacity-recycle',{body:JSON.stringify(result),contentType:'application/json'});
});

test('repeated native cancellation preserves saved output and admits each new generation',async({page},info)=>{
  const result=await page.evaluate(async()=>{
    const f=(window as any).textFixture,q=await f.request('saved appearance');
    const saved=await f.renderer.prepare(q), savedHash=saved.rasterHash, baseline=f.textMemory.snapshot;
    const cycles=[];
    for(let i=0;i<5;i++){
      const pending=f.renderer.prepare({...q,text:'cancelled',token:{...q.token,generation:2*i+2}}).then(()=> 'unexpected',(e:any)=>e.code);
      await Promise.resolve(); f.renderer.cancel();const cancellation=await pending;
      const next=await f.renderer.prepare({...q,text:'current '+i,token:{...q.token,generation:2*i+3}});
      cycles.push({cancellation,text:await next.textUtf8.text(),generation:next.token.generation});f.releasePrepared(next);
    }
    const result={cycles,savedHash,retainedHash:await f.hashBytes(saved.rgba),baseline,reservations:f.textMemory.snapshot,lifecycle:f.renderer.lifecycle};
    f.releasePrepared(saved);f.renderer.dispose();return result;
  });
  for(let i=0;i<5;i++){expect(result.cycles[i]).toEqual({cancellation:'TEXT_CANCELLED',text:'current '+i,generation:2*i+3});}
  expect(result.savedHash).toBe(result.retainedHash);expect(result.lifecycle.terminations).toBe(5);expect(result.lifecycle.uncertainBytes).toBe(0);
  expect(result.reservations).toEqual(result.baseline);
  await info.attach('repeated-cancel',{body:JSON.stringify(result),contentType:'application/json'});
});

test('engine load failure releases private reservations and permits a fresh native worker',async({page},info)=>{
  await page.route('**/*.wasm',route=>route.fulfill({status:200,contentType:'application/wasm',body:Buffer.from([0]),headers:{'content-length':'1'}}));
  const failed=await page.evaluate(async()=>{
    const f=(window as any).textFixture,q=await f.request('retry after failure'),before=f.textMemory.snapshot;
    const code=await f.renderer.prepare(q).then(()=> 'unexpected',(e:any)=>e.code);
    return{code,before,after:f.textMemory.snapshot,lifecycle:f.renderer.lifecycle};
  });
  expect(failed.code).toBe('TEXT_ENGINE_LOAD');expect(failed.after).toEqual(failed.before);expect(failed.lifecycle.uncertainBytes).toBe(0);
  await page.unroute('**/*.wasm');
  const result=await page.evaluate(()=>(window as any).textFixture.render('retry after failure'));
  expect(result.textUtf8).toBe('retry after failure');
  await info.attach('engine-error-recovery',{body:JSON.stringify(failed),contentType:'application/json'});
});

test('shared reservations reject oversized work before worker allocation and preserve inputs',async({page},info)=>{
  const workers:string[]=[];page.on('worker',w=>workers.push(w.url()));
  const result=await page.evaluate(async()=>{
    const f=(window as any).textFixture,q=await f.request('preserved draft'),before=f.textMemory.snapshot;
    async function code(operation:()=>Promise<unknown>){try{await operation();return 'unexpected';}catch(e:any){return e.code;}}
    const oversized=await code(()=>f.renderer.prepare({...q,frame:{width:5000,height:5000}}));
    const shared=f.textMemory.reserve(100*1024**2),otherRenderer=new f.TextRenderer();
    const sharedFailure=await code(()=>otherRenderer.prepare(q));shared.release();
    const other=f.textMemory.reserve(500*1024**2,'other');
    const combined=await code(()=>f.renderer.prepare(q));other.release();
    const after=f.textMemory.snapshot;
    return{oversized,sharedFailure,combined,before,after,text:q.text,fontHash:q.fonts[0].hash};
  });
  expect(result.oversized).toBe('TEXT_MEMORY_BUDGET');expect(result.sharedFailure).toBe('TEXT_MEMORY_BUDGET');expect(result.combined).toBe('TEXT_MEMORY_BUDGET');
  expect(result.after).toEqual(result.before);expect(result.text).toBe('preserved draft');expect(workers).toEqual([]);
  await info.attach('preallocation-refusals',{body:JSON.stringify(result),contentType:'application/json'});
});

});

base('stock native storage reset requires observed closure of every actual text worker',async({playwright,browserName},info)=>{
  const profile=browserName==='webkit'?await mkdtemp(resolve(await realpath(tmpdir()),'ie-text-worker-')):undefined;
  const browser=profile?undefined:await playwright[browserName].launch();
  const context=profile?await playwright.webkit.launchPersistentContext(profile):await browser!.newContext();
  await Promise.all(context.pages().map(p=>p.close()));
  const storage=await ownedOPFS(context,profile??browserName+' ephemeral');
  const page=await context.newPage(),workers:{url:string;closed:boolean}[]=[],errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('worker',w=>{const entry={url:w.url(),closed:false};workers.push(entry);w.on('close',()=>entry.closed=true);});
  let outcome='incomplete',error:string|null=null;
  const marker='text-worker-'+randomUUID();
  try{
    await storage.admit(page,origin);await page.goto(origin);await page.waitForFunction(()=>!!(window as any).textFixture);
    await page.evaluate(async name=>{
      const root=await navigator.storage.getDirectory(),file=await root.getFileHandle(name,{create:true}),writer=await file.createWritable();
      await writer.write('Owned worker cleanup control');await writer.close();
      const f=(window as any).textFixture,q=await f.request('native worker cleanup');
      await f.renderer.prepare(q);
      try{await f.renderer.prepare({...q,text:'𝄞'});}catch(e:any){if(e.code!=='TEXT_MISSING_GLYPHS')throw e;}
    },marker);
    await page.evaluate(async()=>{
      const f=(window as any).textFixture,q=await f.request('cancel real worker');
      (window as any).pendingText=f.renderer.prepare(q).catch((e:any)=>e.code); await Promise.resolve(); f.renderer.cancel();
    });
    const cancellation=await page.evaluate(async()=>{
      const f=(window as any).textFixture;f.renderer.cancel();f.renderer.dispose();return await (window as any).pendingText;
    });
    expect(cancellation).toBe('TEXT_CANCELLED');
    expect(workers.length).toBeGreaterThan(0);
    try{await storage.cleanup();storage.verify();outcome='clean';}catch(e){error=String(e);}
    const reset=storage.ledger.filter((x:any)=>x.phase==='public-reset');
    if(outcome==='clean'){
      expect(workers.every(w=>w.closed)).toBe(true);expect(reset).toHaveLength(1);
      expect(storage.ledger.some((x:any)=>x.phase==='post-reset'&&x.entries.length===0)).toBe(true);
    }else{
      expect(reset).toHaveLength(0);
      expect(storage.ledger.some((x:any)=>x.phase==='cleanup-incomplete')).toBe(true);
      info.annotations.push({type:'cleanup-incomplete',description:error+'; no reset; owned marker absence unclaimed'});
    }
    expect(errors).toEqual([]);
  }finally{
    await info.attach('native-worker-cleanup',{body:JSON.stringify({browserName,origin,marker,outcome,error,workers,errors,ledger:storage.ledger},null,2),contentType:'application/json'});
    await context.close();await browser?.close();
    if(profile&&outcome==='clean')await rm(profile,{recursive:true});
  }
});

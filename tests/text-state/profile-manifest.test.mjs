import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transformWithOxc} from 'vite';
const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const raw=await readFile('src/text/profile.json'),profile=JSON.parse(raw);
const contracts=data((await transformWithOxc(await readFile('src/text/contracts.ts','utf8'),'contracts.ts')).code);
const json=data((await transformWithOxc(await readFile('src/protocol/json.ts','utf8'),'json.ts')).code);
const original={fetch:globalThis.fetch,location:globalThis.location,owner:globalThis.__manifestOwner};
let serial=0;
async function fixture(t,url='/assets/profile-abcdefgh.json'){
 const previous=original;
 const state={held:0,text:0,maxText:0,released:0,requests:[],staged:[],failReserve:false};
 globalThis.location={href:'http://127.0.0.1:9000/',origin:'http://127.0.0.1:9000'};
 globalThis.__manifestOwner={reserve(bytes,category='text'){if(state.failReserve)throw Error('TEXT_MEMORY_BUDGET');state.held+=bytes;if(category==='text'){state.text+=bytes;state.maxText=Math.max(state.maxText,state.text);}let live=true;return {bytes,release(){if(live){live=false;state.held-=bytes;if(category==='text')state.text-=bytes;state.released++;}}};}};
 const respond=()=>new Response(raw,{headers:{'Content-Length':String(raw.length),'Content-Type':'application/json'}});
 state.respond=respond;
 globalThis.fetch=async(url,options)=>{state.requests.push({url:String(url),options});assert(state.held>0,'admission precedes fetch');return state.respond(options);};
 t.after(()=>{globalThis.fetch=previous.fetch;if(previous.location===undefined)delete globalThis.location;else globalThis.location=previous.location;if(previous.owner===undefined)delete globalThis.__manifestOwner;else globalThis.__manifestOwner=previous.owner;});
 const imports={
  './client':data('export class TextRenderer{cancel(){}dispose(){}async prepare(){return globalThis.__manifestOwner.prepared;}}'),
  './memory':data('export const textMemory={reserve:(...args)=>globalThis.__manifestOwner.reserve(...args),get snapshot(){return globalThis.__manifestOwner.snapshot();}};export const releasePrepared=()=>{};export const unownedFontBytes=()=>0;'),
  './contracts':contracts,'../protocol/json':json,
  './profile.json':data('export const id='+JSON.stringify(profile.id)+';export const engine='+JSON.stringify(profile.engine)+';'),
  './profile.json?url&no-inline':data('export default '+JSON.stringify(url)),
  '../protocol/text-budget':data('export const verificationBudget=()=>({bytes:0});'),
 };
 let code=(await transformWithOxc(await readFile('src/text/durable.ts','utf8'),'durable.ts')).code;
 for(const [name,target] of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(target)).replaceAll("'"+name+"'",JSON.stringify(target));
 const module=await import(data(code+'\n// manifest fixture '+(++serial)));
 const token={documentId:'document',documentRevision:'0',layerId:'text',layerVersion:'0',sessionId:'session',generation:1};
 const request={token,text:'exact',style:{},frame:{width:1,height:1},fonts:[]};
 const text=new Blob(['exact']),layout=new Blob(['{}']),rgba=new Blob([new Uint8Array(4)]);
 const prepared={token,rendererProfile:profile.id,dependencies:[],textUtf8:text,textHash:sha('exact'),layout,layoutHash:sha('{}'),rgba,rasterHash:sha(new Uint8Array(4)),dependencyHash:sha('dependencies'),width:1,height:1,overflow:false};
 globalThis.__manifestOwner.prepared=prepared;globalThis.__manifestOwner.snapshot=()=>({cpuBytes:state.held,textBytes:state.text});
 const stage=async(blob,mediaType)=>{const bytes=Buffer.from(await blob.arrayBuffer());state.staged.push({bytes,mediaType,held:state.held});return {hash:sha(bytes),byteLength:String(bytes.length),mediaType};};
 return {...module,state,request,prepared,stage,run:async(signal,put=stage)=>{
  // describePrepared borrows its caller's existing copy workspace. Production
  // prepare retains this owner across the returned candidate and loan handoff.
  const lease=globalThis.__manifestOwner.reserve(3*1024**2);try{return await module.describePrepared(request,prepared,[],put,signal);}finally{lease.release();}
 }};
}
test('module startup does not fetch the manifest; Apply stages its unchanged exact bytes under an owner',async t=>{
 const f=await fixture(t);assert.equal(f.state.requests.length,0);
 const result=await f.run();assert.equal(f.state.requests.length,1);
 assert.equal(f.state.requests[0].url,'http://127.0.0.1:9000/assets/profile-abcdefgh.json');
 assert.equal(f.state.requests[0].options.credentials,'same-origin');assert.equal(f.state.requests[0].options.redirect,'error');
 const staged=f.state.staged[1];assert.deepEqual(staged.bytes,raw);assert.equal(staged.held,3*1024**2,'manifest shares the existing 3MiB staging allowance');
 assert.equal(result.source.render.rendererProfile.manifest.hash,sha(raw));assert.equal(f.state.held,0);assert.equal(f.state.released,1);
});
test('foreign or non-profile URLs are refused before fetch while releasing the existing stage allowance',async t=>{
 for(const url of ['https://example.invalid/assets/profile-abcdefgh.json','/assets/config.json','/assets/profile-abcdefgh.json?other=1']){
  const f=await fixture(t,url);await assert.rejects(f.run(),/TEXT_ASSET_ORIGIN/);assert.equal(f.state.requests.length,0);assert.equal(f.state.held,0);
 }
});
test('admission, fetch and staging failures release only actual owned workspace',async t=>{
 const f=await fixture(t);f.state.failReserve=true;await assert.rejects(f.run(),/TEXT_MEMORY_BUDGET/);assert.equal(f.state.requests.length,0);
 f.state.failReserve=false;f.state.respond=()=>{throw Error('FETCH_FAILED');};await assert.rejects(f.run(),/FETCH_FAILED/);assert.equal(f.state.held,0);
 f.state.respond=()=>new Response(raw,{headers:{'Content-Length':String(raw.length)}});
 await assert.rejects(f.run(undefined,async(blob,type)=>{if(type==='application/json')throw Error('STAGE_FAILED');return f.stage(blob,type);}),/STAGE_FAILED/);assert.equal(f.state.held,0);
});
test('missing, oversized and mismatched lengths cancel the real bounded reader without staging manifest data',async t=>{
 const f=await fixture(t);
 for(const [length,code] of [[null,'TEXT_ASSET_LOAD'],['65537','TEXT_ASSET_LOAD'],[String(raw.length-1),'TEXT_ASSET_SIZE']]){
  let cancelled=0;f.state.respond=()=>new Response(new ReadableStream({start(c){c.enqueue(raw);},cancel(){cancelled++;}}),{headers:length===null?{}:{'Content-Length':length}});
  const before=f.state.staged.length;await assert.rejects(f.run(),error=>error?.code===code);assert.equal(cancelled,1);assert.equal(f.state.held,0);assert.equal(f.state.staged.length,before+1);
 }
});
test('profile metadata mismatch and duplicate-key JSON cannot reach durable staging',async t=>{
 const f=await fixture(t);
 for(const bytes of [Buffer.from(JSON.stringify({...profile,id:'sha256:'+'0'.repeat(64)})),Buffer.from('{"id":"x","id":"x"}')]){
  f.state.respond=()=>new Response(bytes,{headers:{'Content-Length':String(bytes.length)}});
  const before=f.state.staged.length;await assert.rejects(f.run(),error=>error?.message==='TEXT_PROFILE_IDENTITY'||error?.code==='MALFORMED_REQUEST');assert.equal(f.state.staged.length,before+1);assert.equal(f.state.held,0);
 }
});
test('the issuer digest rejects a matching claimed ID with altered, omitted or unexpected metadata',async t=>{
 const f=await fixture(t);
 const changed=structuredClone(profile);changed.sourceRecipe[0].bytes++;
 const omitted=structuredClone(profile);delete omitted.id;
 const extra={...profile,unissuedMetadata:true};
 const unissued=structuredClone(changed);delete unissued.id;unissued.id=sha(JSON.stringify(unissued));
 for(const metadata of [changed,omitted,extra,unissued]){
  const bytes=Buffer.from(JSON.stringify(metadata));f.state.respond=()=>new Response(bytes,{headers:{'Content-Length':String(bytes.length)}});
  const before=f.state.staged.length;await assert.rejects(f.run(),/TEXT_PROFILE_IDENTITY/);
  assert.equal(f.state.staged.length,before+1,'the manifest was not staged');assert.equal(f.state.held,0);
 }
});
test('issuer insertion order is authenticated while original whitespace and exact staged bytes are preserved',async t=>{
 const f=await fixture(t),body={...profile};delete body.id;
 assert.equal(sha(JSON.stringify(body)),profile.id,'actual profile follows the current producer digest');
 const reversed=Object.fromEntries(Object.entries(body).reverse());reversed.id=profile.id;
 const reordered=Buffer.from(JSON.stringify(reversed));f.state.respond=()=>new Response(reordered,{headers:{'Content-Length':String(reordered.length)}});
 await assert.rejects(f.run(),/TEXT_PROFILE_IDENTITY/);assert.equal(f.state.held,0);
 const before=f.state.staged.length;f.state.respond=()=>new Response(raw,{headers:{'Content-Length':String(raw.length)}});
 await f.run();assert.deepEqual(f.state.staged[before+1].bytes,raw,'hashing never replaces the original manifest bytes');assert.equal(f.state.held,0);
});
test('cancellation during actual issuer hashing refuses manifest staging and releases its owner',async t=>{
 const f=await fixture(t),abort=new AbortController(),digest=crypto.subtle.digest.bind(crypto.subtle);
 let observed=false;
 t.mock.method(crypto.subtle,'digest',async(algorithm,bytes)=>{
  const result=await digest(algorithm,bytes);observed=true;abort.abort();return result;
 });
 await assert.rejects(f.run(abort.signal),/TEXT_STALE/);assert.equal(observed,true);
 assert.equal(f.state.staged.length,1);assert.equal(f.state.held,0);
});
test('cancel while a manifest read is pending drains its reader and does not stage a late manifest',async t=>{
 const f=await fixture(t),abort=new AbortController();let began,cancelled=0;
 const reading=new Promise(resolve=>{began=resolve;});
 f.state.respond=options=>{assert.equal(options.signal,abort.signal);return new Response(new ReadableStream({start(){began();},cancel(){cancelled++;}}),{headers:{'Content-Length':String(raw.length)}});};
 const work=f.run(abort.signal);await reading;abort.abort();await assert.rejects(work,/TEXT_CANCELLED/);assert.equal(cancelled,1);assert.equal(f.state.staged.length,1);assert.equal(f.state.held,0);
});
test('cancellation after the first stage refuses before starting the new manifest read',async t=>{
 const f=await fixture(t),abort=new AbortController();
 await assert.rejects(f.run(abort.signal,async(blob,media)=>{const value=await f.stage(blob,media);abort.abort();return value;}),/TEXT_STALE/);
 assert.equal(f.state.requests.length,0);assert.equal(f.state.staged.length,1);assert.equal(f.state.held,0);
});
test('the pinned Vite development URL directive normalizes to the fixed raw source route',async t=>{
 const f=await fixture(t,'/src/text/profile.json?no-inline');await f.run();
 assert.equal(f.state.requests[0].url,'http://127.0.0.1:9000/src/text/profile.json');assert.deepEqual(f.state.staged[1].bytes,raw);
});
test('actual prepare retains its original 3MiB maximum through manifest staging and transfers to the existing loan',async t=>{
 const f=await fixture(t);let released=0;
 const storage={admit:async()=>{},releaseAdmission:async()=>{released++;},stage:f.stage};
 const preparation=new f.DurableTextPreparation(storage),result=await preparation.prepare(f.request,[]);
 assert(result.candidate);assert.equal(f.state.maxText,3*1024**2);assert.equal(f.state.text,65536);
 assert.equal(f.state.staged[1].held,384*1024**2+3*1024**2);assert.deepEqual(f.state.staged[1].bytes,raw);
 preparation.dispose();await f.releaseTextRealm(storage);assert.equal(released,1);assert.equal(f.state.held,0);
});
test('failed reader cleanup retains its actual reservation and blocks another Apply or false realm release',async t=>{
 const f=await fixture(t);f.state.respond=()=>new Response(new ReadableStream({cancel(){throw Error('CANCEL_FAILED');}}));
 const preparation=new f.DurableTextPreparation({admit:async()=>{},releaseAdmission:async()=>{},stage:f.stage});
 await assert.rejects(preparation.prepare(f.request,[]),error=>error?.code==='TEXT_ASSET_CLEANUP');assert.equal(f.state.text,3*1024**2);assert.equal(f.state.released,0);
 await assert.rejects(preparation.prepare(f.request,[]),/TEXT_PROFILE_CLEANUP/);assert.equal(f.state.requests.length,1);
 await assert.rejects(f.releaseTextRealm({releaseAdmission(){assert.fail('Must not release uncertain reader ownership');}}),/TEXT_PROFILE_CLEANUP/);assert(f.state.held>0);
});

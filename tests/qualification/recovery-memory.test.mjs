import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {rolldown} from 'rolldown';
import {createHash} from 'node:crypto';
import {transformWithOxc} from 'vite';

const root=process.env.IE_DISPLAY_SOURCE_ROOT?process.env.IE_DISPLAY_SOURCE_ROOT.replace(/\/$/,'')+'/':'',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');let serial=0;
async function module(path,replacements={},identity=''){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code+'\n// '+identity);}
// Pure protocol dependencies are bundled from current source once. This gate
// must work before an app/server build and cannot consume stale dist output.
let protocolModules;
async function protocols(){
 return protocolModules??=Promise.all(['json','sha256','validate'].map(async name=>{
  const bundle=await rolldown({input:resolve('src/protocol/'+name+'.ts'),platform:'neutral',logLevel:'silent'});
  try{const {output}=await bundle.generate({format:'esm'});assert.equal(output.length,1);return [name,data(output[0].code)];}finally{await bundle.close();}
 }));
}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function fixture(){const id=String(++serial),allocations=await module('src/observability/allocations.ts',{},id),memory=await module(root+'src/observability/recovery-memory.ts',{'./allocations.js':allocations},id),imports={'../observability/recovery-memory.js':memory,'./recovery-cache.js':data('export class RecoveryCache {}')};for(const [name,url]of await protocols())imports['../protocol/'+name+'.js']=url;const consumer=await module(root+'src/state/recovery-client.ts',imports,id);return {...await import(allocations),...await import(memory),...await import(consumer)};}
function cache(){let value={generation:'old',cursor:'0',epoch:'1'};const calls=[];return {calls,async published(){return {...value};},async clone(from,to){calls.push(['clone',from,to]);},async discard(generation){calls.push(['discard',generation]);},async publish(next,old){assert.deepEqual(old,value);value=next;calls.push(['publish',next]);}};}
const recovery={recoveryId:'recovery',writerEpoch:'1',projectionSchema:8,highWater:'0',expiresAt:'2099-01-01T00:00:00.000Z'};
const page=()=>({protocolVersion:1,kind:'batches',recovery,nextCursor:'0',more:false,batches:[]});
async function until(predicate){for(let n=0;n<100&&!predicate();n++)await new Promise(resolve=>setImmediate(resolve));assert.equal(predicate(),true);}

test('enumerated payload slots are admitted before recovery touches the cache or transport',async()=>{
 const f=await fixture(),pressure=f.allocationLedger.reserve({owner:'recovery-pressure',kind:'scratch',cpuBytes:f.ALLOCATION_LIMITS.cpuBytes-f.ALLOCATION_LIMITS.textPartitionBytes-1});let touched=0;
 try{const client=new f.RecoveryConsumer({published(){touched++;}},async()=>{touched++;return Response.json(page());});assert.throws(()=>client.recover(),/ALLOCATION_BUDGET/);assert.equal(touched,0);assert.equal(f.allocationLedger.snapshot().activeRecords,1);}finally{pressure.release();}
});

test('operation workspace stays owned across publication and returns all payload reservations afterward',async()=>{
 const f=await fixture(),c=cache(),gate=deferred(),publish=c.publish.bind(c);c.publish=async(...args)=>{assert.equal(f.allocationLedger.snapshot().cpuBytes,Object.values(f.RECOVERY_PAYLOAD_SLOTS).reduce((n,s)=>n+s.slots*s.utf8Bytes*s.copies,0));await gate.promise;return publish(...args);};let reads=0;
 const client=new f.RecoveryConsumer(c,async()=>{reads++;return Response.json(page());}),work=client.recover();await until(()=>reads===2&&f.allocationLedger.snapshot().byKind.staging.cpuBytes===0);assert.equal(client.ownership.active,true);assert.ok(f.allocationLedger.snapshot().cpuBytes>0);gate.resolve();assert.equal(await work,'0');assert.equal(c.calls.filter(([kind])=>kind==='publish').length,1);assert.equal(f.allocationLedger.snapshot().activeRecords,0);assert.equal(client.ownership.active,false);
});

test('twenty thousand one-byte control chunks use a fixed buffer and bounded handles',async()=>{
 const f=await fixture(),c=cache(),bytes=new TextEncoder().encode(' '.repeat(20000)+JSON.stringify(page()));let reads=0;
 const client=new f.RecoveryConsumer(c,async()=>{if(reads++)return Response.json(page());let at=0;return new Response(new ReadableStream({pull(controller){if(at===bytes.length)controller.close();else controller.enqueue(bytes.subarray(at,++at));}}),{headers:{'content-type':'application/json'}});});
 assert.equal(await client.recover(),'0');assert.ok(f.allocationLedger.snapshot().peaks.handles<16);assert.equal(f.allocationLedger.snapshot().activeRecords,0);
});

test('oversized control payload fails before publication and releases incoming chunk and workspace',async()=>{
 const f=await fixture(),c=cache(),client=new f.RecoveryConsumer(c,async()=>new Response(new Uint8Array(65537),{headers:{'content-type':'application/json'}}));await assert.rejects(client.recover());assert.equal((await c.published()).generation,'old');assert.equal(c.calls.some(([kind])=>kind==='publish'),false);assert.equal(f.allocationLedger.snapshot().activeRecords,0);
});

test('a delivered chunk stays admitted while its application consumer is suspended',async()=>{
 const f=await fixture(),workspace=new f.RecoveryWorkspace(),response=await workspace.request(async()=>new Response(new Uint8Array(777)),'/local'),iterator=workspace.chunks(response),part=await iterator.next();assert.equal(part.value.byteLength,777);assert.equal(f.allocationLedger.snapshot().byKind.staging.cpuBytes,777);await iterator.return();assert.equal(f.allocationLedger.snapshot().byKind.staging.cpuBytes,0);await workspace.release();assert.equal(f.allocationLedger.snapshot().activeRecords,0);
});

test('release aborts a body even when transport ignores its signal and waits for native cancellation',async()=>{
 const f=await fixture(),c=cache(),cancel=deferred();let entered=false,canceled=0,signal;
 const body=new ReadableStream({pull(){entered=true;},cancel(){canceled++;return cancel.promise;}}),client=new f.RecoveryConsumer(c,async(_path,init)=>{signal=init.signal;return new Response(body,{headers:{'content-type':'application/json'}});}),work=client.recover();void work.catch(()=>{});await until(()=>entered&&!!signal);let released=false;const release=client.release().then(()=>{released=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(signal.aborted,true);assert.equal(canceled,1);assert.equal(released,false);assert.ok(f.allocationLedger.snapshot().cpuBytes>0);cancel.resolve();await assert.rejects(work,error=>error.name==='AbortError');await release;assert.equal(f.allocationLedger.snapshot().activeRecords,0);assert.equal((await c.published()).generation,'old');
});

test('native body cancellation failure keeps an unused response handle and prevents false release',async()=>{
 const f=await fixture(),c=cache();let entered=false;
 const body=new ReadableStream({pull(){entered=true;},cancel(){return Promise.reject(Error('native cancellation failure'));}}),client=new f.RecoveryConsumer(c,async()=>new Response(body,{headers:{'content-type':'application/json'}})),work=client.recover();void work.catch(()=>{});await until(()=>entered&&f.allocationLedger.snapshot().activeRecords>5);await assert.rejects(client.release(),/RECOVERY_RELEASE_UNCONFIRMED/);await assert.rejects(work,/RECOVERY_RELEASE_UNCONFIRMED/);assert.equal(client.ownership.cleanupFailed,true);assert.ok(f.allocationLedger.snapshot().unusedHandles>0);assert.throws(()=>client.recover(),/RECOVERY_RELEASE_UNCONFIRMED/);
});

test('SSE checkpoint framing remains valid and an external abort drains a pending stream',async()=>{
 const f=await fixture(),c=cache(),controller=new AbortController(),checkpoint='data: '+JSON.stringify({protocolVersion:1,kind:'checkpoint',highWater:'0'})+'\n\n';let sent=false,waiting=false;
 const body=new ReadableStream({pull(stream){if(!sent){sent=true;stream.enqueue(new TextEncoder().encode(checkpoint));}else waiting=true;}}),client=new f.RecoveryConsumer(c,async()=>new Response(body,{headers:{'content-type':'text/event-stream'}})),work=client.consumeStream(controller.signal);void work.catch(()=>{});await until(()=>waiting);controller.abort();await assert.rejects(work,error=>error.name==='AbortError');await client.release();assert.equal((await c.published()).cursor,'0');assert.equal(f.allocationLedger.snapshot().activeRecords,0);
});

test('entity assembly preserves UTF-8 parts, caps retained bytes before a copy, and clears between rows',async()=>{
 const f=await fixture(),workspace=new f.RecoveryWorkspace(),entity=new f.RecoveryEntityBuffer();const first='{"name":"東京',last='😀"}';entity.append(Buffer.from(first).toString('base64'));entity.append(Buffer.from(last).toString('base64'));assert.equal(entity.text(),first+last);entity.clear();assert.equal(entity.value().byteLength,0);
 const part=Buffer.alloc(16384,97).toString('base64');for(let i=0;i<4;i++)entity.append(part);assert.equal(entity.value().byteLength,65536);assert.throws(()=>entity.append('YQ=='),/RECOVERY_ENTITY_SIZE/);assert.equal(entity.value().byteLength,65536);entity.clear();assert.throws(()=>entity.append('/w=='));assert.equal(entity.value().byteLength,0);await workspace.release();assert.equal(f.allocationLedger.snapshot().activeRecords,0);
});

test('JSONL accepts exact event-line bounds, enforces snapshot newline allowance, and verifies content identity',async()=>{
 const f=await fixture(),line=JSON.stringify({s:'x'.repeat(16376)});assert.equal(Buffer.byteLength(line),16384);const bytes=Buffer.from(line+'\n'),digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
 const ref=encoding=>({contentId:'content',url:'/api/v1/protocol-content/content?recoveryId=recovery',blob:{hash:digest,byteLength:String(bytes.length),mediaType:'application/x-ndjson'},encoding,recordCount:'1',expiresAt:'2099-01-01T00:00:00.000Z'});
 const transport=async()=>new Response(bytes,{headers:{etag:'"'+digest+'"','content-length':String(bytes.length),'content-type':'application/x-ndjson'}}),client=new f.RecoveryConsumer(cache(),transport);let accepted=0;
 await client.begin(()=>client.rows(ref('lp1-events-jsonl'),recovery,'lp1-events-jsonl',async row=>{accepted++;assert.equal(row.s.length,16376);assert.equal(f.allocationLedger.snapshot().byKind.staging.cpuBytes,bytes.length);}));assert.equal(accepted,1);assert.equal(f.allocationLedger.snapshot().activeRecords,0);
 await assert.rejects(client.begin(()=>client.rows(ref('lp1-snapshot-jsonl'),recovery,'lp1-snapshot-jsonl',async()=>{throw Error('Oversized row must never be accepted');})));assert.equal(f.allocationLedger.snapshot().activeRecords,0);
 const corrupt=new f.RecoveryConsumer(cache(),async()=>new Response(Buffer.from(bytes).fill(121,6,7),{headers:{etag:'"'+digest+'"','content-length':String(bytes.length),'content-type':'application/x-ndjson'}}));await assert.rejects(corrupt.begin(()=>corrupt.rows(ref('lp1-events-jsonl'),recovery,'lp1-events-jsonl',async()=>{})),/Content integrity check failed/);assert.equal(f.allocationLedger.snapshot().activeRecords,0);
});

test('reader unlock failure retains its native handle after operation payload slots are retired',async()=>{
 const f=await fixture(),workspace=new f.RecoveryWorkspace(),response={body:{getReader:()=>({async read(){return {done:true};},async cancel(){},releaseLock(){throw Error('native unlock failed');}})}};
 await workspace.request(async()=>response,'/local');await assert.rejects(async()=>{for await(const value of workspace.chunks(response))assert.fail(String(value));},/RECOVERY_RELEASE_UNCONFIRMED/);await assert.rejects(workspace.release(),/RECOVERY_RELEASE_UNCONFIRMED/);const state=f.allocationLedger.snapshot();assert.equal(state.cpuBytes,0);assert.equal(state.unusedHandles,2);assert.equal(state.activeRecords,1);
});

test('a consumer retains a failed workspace and can retry unlocking its exact reader',async()=>{
 const f=await fixture(),c=cache(),bytes=new TextEncoder().encode(JSON.stringify(page()));let mayUnlock=false,reads=0,unlocks=0;
 const reader={async read(){return reads++?{done:true}:{done:false,value:bytes};},async cancel(){},releaseLock(){unlocks++;if(!mayUnlock)throw Error('native unlock temporarily failed');}},response={status:200,headers:new Headers({'content-type':'application/json'}),body:{getReader:()=>reader}},client=new f.RecoveryConsumer(c,async()=>response);
 await assert.rejects(client.recover(),/RECOVERY_RELEASE_UNCONFIRMED/);assert.ok(client.workspace,'The actual reader owner remains reachable after the operation rejects');assert.equal(client.ownership.cleanupFailed,true);assert.equal(f.allocationLedger.snapshot().unusedHandles,2);mayUnlock=true;await client.release();assert.ok(unlocks>=3);assert.equal(client.ownership.cleanupFailed,false);assert.equal(client.workspace,undefined);assert.equal(f.allocationLedger.snapshot().activeRecords,0);
});

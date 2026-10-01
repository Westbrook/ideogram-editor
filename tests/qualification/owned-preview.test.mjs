import test from 'node:test';
import assert from 'node:assert/strict';
import {allocationsURL,ownedPreviewURL} from '../owned-preview-module.mjs';
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL);
const {readOwnedPreviewResponse,createOwnedPreviewURL,revokeOwnedPreviewURL}=await import(ownedPreviewURL);
const options={owner:'preview-test'};
const bytes=value=>new TextEncoder().encode(value);
const response=value=>new Response(value,{headers:{'content-length':String(bytes(value).byteLength),'content-type':'image/png'}});
test.afterEach(()=>assert.equal(allocationLedger.snapshot().activeRecords,0,'Every test releases its owned backing'));

test('known length reserves before the body read and transfers one backing lease to its URL',async()=>{
 let readSnapshot;const body=new ReadableStream({pull(controller){readSnapshot=allocationLedger.snapshot();controller.enqueue(bytes('exact'));controller.close();}},{highWaterMark:0});
 const preview=await readOwnedPreviewResponse(new Response(body,{headers:{'content-length':'5','content-type':'image/png'}}),options);
 assert.equal(readSnapshot.cpuBytes,15);assert.equal(readSnapshot.previewCacheBytes,5);assert.equal(readSnapshot.activeRecords,1);
 assert.equal(await preview.blob.text(),'exact');assert.equal(preview.blob.type,'image/png');assert.equal(allocationLedger.snapshot().cpuBytes,5);
 const url=preview.createURL();preview.release();assert.equal(allocationLedger.snapshot().activeRecords,1);assert.throws(()=>preview.createURL(),/transferred or released/);
 revokeOwnedPreviewURL(url);revokeOwnedPreviewURL(url);assert.equal(allocationLedger.snapshot().cpuBytes,0);
});

test('lengthless reads use an explicit bound and drop the reservation on overflow',async()=>{
 let admitted;const body=new ReadableStream({pull(controller){admitted=allocationLedger.snapshot();controller.enqueue(bytes('oversized'));controller.close();}},{highWaterMark:0});
 await assert.rejects(createOwnedPreviewURL(new Response(body),{...options,maxBytes:4}),/PREVIEW_CAPACITY/);
 assert.equal(admitted.cpuBytes,12);assert.equal(admitted.previewCacheBytes,4);
});

test('admission failure cancels an unread body without allocating or pulling its content',async()=>{
 const full=allocationLedger.reserve({owner:'occupied-test',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes});let pulls=0,cancels=0;
 const body=new ReadableStream({pull(){pulls++;},cancel(){cancels++;}},{highWaterMark:0});
 try{await assert.rejects(createOwnedPreviewURL(new Response(body,{headers:{'content-length':'1'}}),options),/ALLOCATION_BUDGET/);assert.equal(pulls,0);assert.equal(cancels,1);}finally{full.release();}
});

for(const [name,body,headers,extra]of [
 ['truncated','two',{'content-length':'4'},{}],
 ['excess','four',{'content-length':'3'},{}],
 ['asset mismatch','same',{'content-length':'4'},{expectedBytes:5}],
 ['malformed length','same',{'content-length':'4.0'},{}],
])test(name+' cannot expose a URL or retain an allocation',async()=>{
 await assert.rejects(createOwnedPreviewURL(new Response(body,{headers}),{...options,...extra}),/Preview content|PREVIEW_CAPACITY/);
});

test('aborting a pending read cancels the stream and releases its admitted backing',async()=>{
 let begin,cancels=0;const started=new Promise(resolve=>begin=resolve),abort=new AbortController();
 const body=new ReadableStream({pull(){begin();},cancel(){cancels++;}},{highWaterMark:0});
 const pending=createOwnedPreviewURL(new Response(body,{headers:{'content-length':'16'}}),{...options,signal:abort.signal});await started;
 assert.equal(allocationLedger.snapshot().previewCacheBytes,16);abort.abort();await assert.rejects(pending,/superseded/);assert.equal(cancels,1);
});

test('a stale owner cannot transfer its already assembled blob to a URL',async()=>{
 let current=true;const preview=await readOwnedPreviewResponse(response('image'),{...options,owns:()=>current});current=false;
 try{assert.throws(()=>preview.createURL(),/superseded/);}finally{preview.release();preview.release();}
});

test('URL creation failure releases the encoded backing',async t=>{
 t.mock.method(URL,'createObjectURL',()=>{throw Error('URL unavailable');});await assert.rejects(createOwnedPreviewURL(response('image'),options),/URL unavailable/);
});

test('transient decoding input remains CPU owned without claiming a second preview cache entry',async()=>{
 const preview=await readOwnedPreviewResponse(response('image'),{...options,previewCache:false});
 assert.equal(allocationLedger.snapshot().cpuBytes,5);assert.equal(allocationLedger.snapshot().previewCacheBytes,0);preview.release();assert.throws(()=>preview.blob,/released/);
});

test('failed URL revocation retains its ownership until cleanup actually succeeds',async t=>{
 const url=await createOwnedPreviewURL(response('image'),options),revoke=URL.revokeObjectURL;let fail=true;
 t.mock.method(URL,'revokeObjectURL',value=>{if(fail)throw Error('Revoke unavailable');return revoke(value);});
 assert.throws(()=>revokeOwnedPreviewURL(url),/Revoke unavailable/);assert.equal(allocationLedger.snapshot().cpuBytes,5);assert.equal(allocationLedger.snapshot().unusedHandles,1);
 fail=false;revokeOwnedPreviewURL(url);assert.equal(allocationLedger.snapshot().activeRecords,0);
});

test('a failed first reader unlock cannot orphan the return value and its backing lease',async t=>{
 const release=ReadableStreamDefaultReader.prototype.releaseLock;let first=true;
 t.mock.method(ReadableStreamDefaultReader.prototype,'releaseLock',function(){if(first){first=false;throw Error('Reader unlock failed');}return release.call(this);});
 await assert.rejects(readOwnedPreviewResponse(response('image'),options),/Reader unlock failed/);assert.equal(first,false);
});

test('bounded slabs retain exact bytes across source chunks and release unused scratch',async()=>{
 const input=Uint8Array.from({length:131079},(_,i)=>i%251),body=new ReadableStream({start(controller){for(let offset=0;offset<input.length;offset+=17)controller.enqueue(input.subarray(offset,offset+17));controller.close();}});
 const preview=await readOwnedPreviewResponse(new Response(body,{headers:{'content-length':String(input.length)}}),options);
 try{assert.deepEqual(new Uint8Array(await preview.blob.arrayBuffer()),input);assert.equal(allocationLedger.snapshot().cpuBytes,input.length);assert.equal(allocationLedger.snapshot().handles,1);}finally{preview.release();}
});

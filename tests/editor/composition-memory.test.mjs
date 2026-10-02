// Staged source only. Run after promotion with the pinned toolchain; no gate or
// runtime execution was performed while production was frozen.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {isolatedDiagnosticModules} from '../owned-preview-module.mjs';

const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function source(path,imports={}){
 let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;
 for(const [specifier,url] of Object.entries(imports))code=code.replaceAll(JSON.stringify(specifier),JSON.stringify(url)).replaceAll("'"+specifier+"'",JSON.stringify(url));
 return data(code);
}
const prefix=process.env.COMPOSITION_STAGED_ROOT??'.';
const {allocationsURL:allocationURL,compositionObservationsURL:observationURL}=await isolatedDiagnosticModules();
const promptURL=await source(prefix+'/src/observability/prompt-memory.ts',{'./allocations.js':allocationURL});
const coreURL=await source(prefix+'/src/composition/core.ts');
const compositionViewURL=await source(prefix+'/src/composition/view.ts');
const memoryURL=await source(prefix+'/src/composition/memory.ts',{'../observability/allocations.js':allocationURL,'../observability/prompt-memory.js':promptURL,'../observability/composition-observations.js':observationURL,'./view.js':compositionViewURL,'./core.js':coreURL});
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationURL);
const {reservePromptPayload,readRetainedPrompt,PromptReaderCleanupError}=await import(promptURL);
const {createCompositionValue,cloneCompositionValue,readCompositionBytes,CompositionReadCleanupError}=await import(memoryURL);
const {bytes,validString,emptyComposition,serialize}=await import(coreURL);
const utf8=new TextEncoder();
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test('composition counters preserve UTF8 and wire JSON bytes',()=>{
 const values=['','ASCII','\x00\b\t\n\f\r"\\','\u007f\u0080\u07ff\u0800\ud7ff\ue000\uffff','😀','\ud800','\udc00','\ud800\ud800\udc00','\u2028\u2029'];
 for(const value of values)assert.equal(bytes(value),utf8.encode(value).byteLength);
 assert.equal(validString('\ud800'),false);assert.equal(validString('😀'.repeat(4096)),true);assert.equal(validString('😀'.repeat(4097)),false);
 const c=emptyComposition(100,100,'caption');c.scene='A "scene"\n😀';const result=serialize(c,[],{});
 assert.equal(result.wirePromptBytes,utf8.encode(JSON.stringify(result.prompt)).byteLength);
});
test('refused composition admission never enters the allocating callback',()=>{
 const blocker=allocationLedger.reserve({owner:'composition-test-blocker',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes});let created=false;
 try{assert.throws(()=>createCompositionValue('composition-test',8,()=>{created=true;return 1;}),/PROMPT_MEMORY_BUDGET/);assert.equal(created,false);}finally{blocker.release();}
});
test('clone ownership survives UI release until its async pin drains',()=>{
 const before=allocationLedger.snapshot().cpuBytes,owned=cloneCompositionValue({scene:'retained',rect:[0,0,1,1]}),unpin=owned.owner.pin();
 assert.ok(allocationLedger.snapshot().cpuBytes>before);owned.owner.release();assert.ok(allocationLedger.snapshot().cpuBytes>before);unpin();assert.equal(allocationLedger.snapshot().cpuBytes,before);
});
test('raw read owns its buffer until cancellation settles',async()=>{
 const before=allocationLedger.snapshot().cpuBytes,gate=deferred();
 const response=new Response(new ReadableStream({cancel(){return gate.promise;}}),{headers:{'content-length':'8'}});
 const read=readCompositionBytes(response,8,()=>false,new AbortController().signal);
 await flush();assert.equal(allocationLedger.snapshot().cpuBytes,before+8);gate.resolve();await assert.rejects(read,/COMPOSITION_READ_STALE/);assert.equal(allocationLedger.snapshot().cpuBytes,before);
});
test('raw reader enforces exact bytes before returning ownership',async()=>{
 const response=new Response(new Uint8Array([1,2,3]),{headers:{'content-length':'3'}}),before=allocationLedger.snapshot().cpuBytes;
 const owned=await readCompositionBytes(response,3,()=>true,new AbortController().signal);
 assert.deepEqual([...owned.value],[1,2,3]);assert.equal(allocationLedger.snapshot().cpuBytes,before+3);owned.owner.release();assert.equal(allocationLedger.snapshot().cpuBytes,before);
 await assert.rejects(readCompositionBytes(new Response(new Uint8Array([1,2,3]),{headers:{'content-length':'2'}}),3,()=>true,new AbortController().signal),/COMPOSITION_CONTENT_SIZE/);
});
test('failed unlock keeps the actual reader and can release on a later successful retry',async()=>{
 const before=allocationLedger.snapshot().cpuBytes,primary=Error('read failed'),unlock=Error('unlock failed');let attempts=0;
 const reader={async read(){throw primary;},async cancel(){},releaseLock(){if(++attempts<3)throw unlock;}};
 const response={headers:new Headers({'content-length':'8'}),body:{getReader:()=>reader}};let failure;
 await assert.rejects(readCompositionBytes(response,8,()=>true,new AbortController().signal),error=>{failure=error;return error instanceof PromptReaderCleanupError;});
 assert.equal(failure.resource.response,response);assert.equal(failure.resource.retainedReader,reader);assert.ok(failure.errors.includes(primary));assert.ok(failure.errors.includes(unlock));assert.equal(allocationLedger.snapshot().cpuBytes,before+8);
 await assert.rejects(failure.retry(),/PROMPT_READER_UNLOCK_RETRY_FAILED/);assert.equal(allocationLedger.snapshot().cpuBytes,before+8);
 await failure.retry();assert.equal(allocationLedger.snapshot().cpuBytes,before);
});
test('genuine source cancellation AbortError remains owned after signal abort',async()=>{
 const before=allocationLedger.snapshot(),abort=new AbortController();abort.abort();
 const response=new Response(new ReadableStream({cancel(){throw new DOMException('aborted native stream','AbortError');}}),{headers:{'content-length':'8'}});
 await assert.rejects(readCompositionBytes(response,8,()=>false,abort.signal),error=>error instanceof PromptReaderCleanupError&&error.cancellationFailed);
 assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords+1);assert.equal(allocationLedger.snapshot().unusedHandles,before.unusedHandles+2);
});
test('prefetch handle remains owned when payload refusal is followed by native cancellation failure',async()=>{
 const admitted=reservePromptPayload('composition-test-prefetch',0),blocker=reservePromptPayload('composition-test-pressure',ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes),before=allocationLedger.snapshot();
 const native=Error('cancel after refused payload'),response=new Response(new ReadableStream({cancel(){throw native;}}));let failure;
 try{await assert.rejects(readRetainedPrompt(response,1,()=>true,undefined,admitted),error=>{failure=error;return error instanceof PromptReaderCleanupError;});
  assert.equal(failure.resource.lease,admitted);assert.equal(failure.resource.response,response);assert.ok(failure.errors.some(error=>error instanceof Error&&error.message==='PROMPT_MEMORY_BUDGET'));assert.ok(failure.errors.includes(native));
  assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords);assert.equal(allocationLedger.snapshot().unusedHandles,before.unusedHandles+2);await assert.rejects(failure.retry(),PromptReaderCleanupError);
 }finally{blocker.release();}
});
test('failed cancellation remains visibly charged and unused',async()=>{
 const before=allocationLedger.snapshot(),response=new Response(new ReadableStream({cancel(){throw Error('native cancellation failed');}}),{headers:{'content-length':'8'}});
 await assert.rejects(readCompositionBytes(response,8,()=>false,new AbortController().signal),CompositionReadCleanupError);
 const after=allocationLedger.snapshot();assert.equal(after.cpuBytes,before.cpuBytes+8);assert.equal(after.unusedHandles,before.unusedHandles+2);
});
test('throw undefined is still a sticky native cancellation failure',async()=>{
 const before=allocationLedger.snapshot(),response=new Response(new ReadableStream({cancel(){throw undefined;}}),{headers:{'content-length':'8'}});let failure;
 await assert.rejects(readCompositionBytes(response,8,()=>false,new AbortController().signal),error=>{failure=error;return error instanceof PromptReaderCleanupError;});
 assert.equal(failure.cancellationFailed,true);assert.ok(failure.errors.includes(undefined));assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes+8);await assert.rejects(failure.retry(),PromptReaderCleanupError);
});

// Each new lifetime fixture receives the real isolated producer/ledger graph:
// retained native cleanup debt in another case must not become its baseline.
async function controlCompositionFixture(){
 const modules=await isolatedDiagnosticModules();
 const localPromptURL=await source(prefix+'/src/observability/prompt-memory.ts',{'./allocations.js':modules.allocationsURL});
 const localMemoryURL=await source(prefix+'/src/composition/memory.ts',{'../observability/allocations.js':modules.allocationsURL,'../observability/prompt-memory.js':localPromptURL,'../observability/composition-observations.js':modules.compositionObservationsURL,'./view.js':compositionViewURL,'./core.js':coreURL});
 return {...await import(localMemoryURL),allocationLedger:(await import(modules.allocationsURL)).allocationLedger,observations:(await import(modules.compositionObservationsURL)).compositionObservations};
}
function compositionSnapshot(observer){const read=observer.readSnapshot();try{return structuredClone(read.value);}finally{read.release();}}

test('control render ownership survives UI release until the last async pin drains',async()=>{
 const graph=await controlCompositionFixture(),before=compositionSnapshot(graph.observations);
 const prompt=graph.compositionAllowance('composition-test-prompt',11),render=graph.compositionRenderAllowance(37),unpin=render.pin();
 try{
  render.grow(13);render.release();
  const retained=compositionSnapshot(graph.observations);
  assert.equal(retained.compositionControlOwnedBytes,50);assert.equal(retained.promptOwnedBytes,11);assert.equal(retained.rawInspectionOwnedBytes,0);
  unpin();const drained=compositionSnapshot(graph.observations);
  assert.equal(drained.compositionControlOwnedBytes,0);assert.equal(drained.promptOwnedBytes,11);
  assert.deepEqual(drained.records.filter(row=>row.sequence>before.cursor&&row.kind==='control-ownership').map(row=>row.compositionControlOwnedBytes),[37,50,0]);
  const cursor=drained.cursor;unpin();render.release();assert.equal(compositionSnapshot(graph.observations).cursor,cursor);
 }finally{unpin();render.release();prompt.release();}
 const after=compositionSnapshot(graph.observations);assert.equal(after.compositionControlOwnedBytes,0);assert.equal(after.promptOwnedBytes,0);assert.equal(after.physicalMemoryComplete,false);
});

test('JSON response read records simultaneous control raw and parse allowances without charging raw inspection',async()=>{
 const graph=await controlCompositionFixture(),value={caption:'ok',scene:'😀'},payload=utf8.encode(JSON.stringify(value)),prompt=graph.compositionAllowance('composition-test-prompt',9);
 const before=compositionSnapshot(graph.observations),admitted=graph.reserveCompositionRead();let owned;
 try{
  owned=await graph.readCompositionJSON(new Response(payload,{headers:{'content-length':String(payload.byteLength)}}),()=>true,new AbortController().signal,'accepted',admitted);
  assert.deepEqual(owned.value,value);
  const after=compositionSnapshot(graph.observations),rows=after.records.filter(row=>row.sequence>before.cursor);
  assert.equal(Math.max(...rows.map(row=>row.compositionControlOwnedBytes)),payload.byteLength*7+8,'raw n and parse/decode 6n+8 coexist');
  assert.equal(after.compositionControlOwnedBytes,graph.compositionPayloadBytes(value));
  assert(rows.every(row=>row.kind==='control-ownership'&&row.promptOwnedBytes===9&&row.rawInspectionOwnedBytes===0));
  assert.equal(after.physicalMemoryComplete,false);
 }finally{owned?.owner.release();prompt.release();}
 const after=compositionSnapshot(graph.observations);assert.equal(after.compositionControlOwnedBytes,0);assert.equal(after.promptOwnedBytes,0);
});

test('malformed JSON releases both control raw and parse owners after preserving their overlap',async()=>{
 const graph=await controlCompositionFixture(),payload=utf8.encode('{broken'),before=compositionSnapshot(graph.observations);
 await assert.rejects(graph.readCompositionJSON(new Response(payload,{headers:{'content-length':String(payload.byteLength)}}),()=>true,new AbortController().signal,'draft',graph.reserveCompositionRead()),SyntaxError);
 const after=compositionSnapshot(graph.observations),rows=after.records.filter(row=>row.sequence>before.cursor);
 assert.equal(Math.max(...rows.map(row=>row.compositionControlOwnedBytes)),payload.byteLength*7+8);
 assert.equal(after.compositionControlOwnedBytes,0);assert.equal(after.promptOwnedBytes,0);assert.equal(after.rawInspectionOwnedBytes,0);
 assert.equal(rows.at(-1).compositionControlOwnedBytes,0);assert(rows.every(row=>row.kind==='control-ownership'));
});

test('failed JSON reader unlock keeps control cleanup debt until actual retry succeeds',async()=>{
 const graph=await controlCompositionFixture(),gate=deferred(),cancelStarted=deferred(),primary=Error('control read failed'),unlock=Error('control unlock failed');let attempts=0,failure;
 const reader={async read(){throw primary;},cancel(){cancelStarted.resolve();return gate.promise;},releaseLock(){if(++attempts===1)throw unlock;}};
 const response={ok:true,headers:new Headers({'content-length':'8'}),body:{getReader:()=>reader}},before=graph.allocationLedger.snapshot();
 const pending=graph.readCompositionJSON(response,()=>true,new AbortController().signal,'accepted',graph.reserveCompositionRead());
 await cancelStarted.promise;
 try{const waiting=compositionSnapshot(graph.observations);assert.equal(waiting.compositionControlOwnedBytes,8);assert.equal(waiting.promptOwnedBytes,0);assert.equal(waiting.rawInspectionOwnedBytes,0);}
 finally{gate.resolve();}
 await assert.rejects(pending,error=>{failure=error;return error instanceof graph.CompositionReadCleanupError;});
 assert.equal(failure.resource.response,response);assert.equal(failure.resource.retainedReader,reader);assert.ok(failure.errors.includes(primary));assert.ok(failure.errors.includes(unlock));
 const debt=compositionSnapshot(graph.observations),charged=graph.allocationLedger.snapshot();
 assert.equal(debt.compositionControlOwnedBytes,8);assert.equal(charged.byKind.control.cpuBytes,before.byKind.control.cpuBytes+8);assert.equal(charged.unusedHandles,before.unusedHandles+2);
 await failure.retry();const after=compositionSnapshot(graph.observations);
 assert.equal(after.compositionControlOwnedBytes,0);assert.equal(after.promptOwnedBytes,0);assert.equal(graph.allocationLedger.snapshot().unusedHandles,before.unusedHandles);
 assert.equal(after.records.filter(row=>row.sequence>debt.cursor&&row.kind==='control-ownership').length,1,'markUnused does not fabricate a release; successful retry releases once');
 const cursor=after.cursor;await failure.retry();assert.equal(compositionSnapshot(graph.observations).cursor,cursor);
});

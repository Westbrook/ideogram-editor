import {isolatedDiagnosticModules,allocationDeltaSnapshot} from '../owned-preview-module.mjs';
import {assetProjectionURL,assetProjection,canonicalDisplayAsset} from '../asset-projection-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');let serial=0;
async function moduleURL(path,imports={},identity=''){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code+'\n// '+identity);}
async function fixture(){const id=String(++serial),allocation=(await isolatedDiagnosticModules()).allocationsURL,prompt=await moduleURL('src/observability/prompt-memory.ts',{'./allocations.js':allocation},id),recovery=await moduleURL('src/observability/recovery-memory.ts',{'./allocations.js':allocation},id);const ledger=await import(allocation);return {allocation,prompt,...ledger,...await import(prompt),...await import(recovery),snapshot:allocationDeltaSnapshot(ledger.allocationLedger)};}
async function displayModules(f){
 const model=await moduleURL('src/observability/model-memory.ts',{'./allocations.js':f.allocation,'./prompt-memory.js':f.prompt}),control=await moduleURL('src/observability/display-control.ts',{'./model-memory.js':model});
 const protocol=await moduleURL('src/protocol/display.ts'),sha=await moduleURL('src/protocol/sha256.ts'),scheduler=await moduleURL('src/observability/display-scheduler.ts',{'./allocations.js':f.allocation});
 const preview=await moduleURL('src/observability/display-preview.ts',{'./allocations.js':f.allocation,'./model-memory.js':model,'./display-control.js':control,'./display-scheduler.js':scheduler,'../protocol/display.js':protocol,'../protocol/sha256.js':sha,'../protocol/asset-projection.js':assetProjectionURL});
 const tiles=await moduleURL('src/ui/display-tiles.ts',{'../observability/allocations.js':f.allocation,'../observability/display-control.js':control,'../observability/display-scheduler.js':scheduler,'../protocol/display.js':protocol,'../protocol/sha256.js':sha,'../protocol/asset-projection.js':assetProjectionURL});
 return {preview,tiles};
}
const errored=(reason,headers={'content-length':'1'})=>new Response(new ReadableStream({start(controller){controller.error(reason);}}),{headers});
const observe=async work=>{let rejected=false,error;try{await work;}catch(value){rejected=true;error=value;}return {rejected,error};};
for(const stored of ['error','undefined'])test('native errored read '+stored+' is terminal after unlock and does not poison future prompt release',async()=>{
 const f=await fixture(),reason=stored==='error'?new TypeError('network interrupted'):undefined,response=errored(reason),before=f.snapshot();
 const result=await observe(f.readRetainedPrompt(response,1,()=>true));assert.equal(result.rejected,true);assert(Object.is(result.error,reason));assert.equal(response.body.locked,false);assert.equal(f.promptReaderCleanupFailures().length,0);await f.retryPromptReaderCleanups();assert.equal(f.snapshot().activeRecords,before.activeRecords);
 const next=await f.readRetainedPrompt(new Response('x'),1,()=>true);assert.equal(next.text,'x');next.lease.release();assert.equal(f.snapshot().cpuBytes,before.cpuBytes);
});
test('a genuine native underlying cancel rejection stays retained even though reader.closed resolves',async()=>{
 const f=await fixture(),cause=new TypeError('underlying cancel did not finish');let calls=0;const response=new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));},cancel(){calls++;throw cause;}}));
 const result=await observe(f.readRetainedPrompt(response,0,()=>true));assert(result.error instanceof f.PromptReaderCleanupError);assert.equal(result.error.cancellationFailed,true);assert.equal(calls,1);assert.equal(response.body.locked,false);assert.equal(f.promptReaderCleanupFailures().length,1);assert.equal(f.snapshot().unusedHandles,2);await assert.rejects(f.retryPromptReaderCleanups(),/PROMPT_READER_CLEANUP_INCOMPLETE/);assert.equal(calls,1);assert.equal(f.snapshot().activeRecords,1);
});
test('terminal native read still retains an actual reader until a faulted unlock succeeds',async()=>{
 const f=await fixture(),cause=new TypeError('network interrupted'),response=errored(cause),nativeGet=response.body.getReader.bind(response.body);let reader,unlocks=0;
 // Only the release boundary is fault-injected; the stream, read, closed and
 // cancellation algorithms are native ReadableStream implementations.
 response.body.getReader=()=>{reader=nativeGet();const nativeRelease=reader.releaseLock.bind(reader);reader.releaseLock=()=>{if(++unlocks===1)throw Error('unlock fault');nativeRelease();};return reader;};
 const result=await observe(f.readRetainedPrompt(response,1,()=>true));assert(result.error instanceof f.PromptReaderCleanupError);assert.equal(result.error.cancellationFailed,false);assert.equal(response.body.locked,true);assert.equal(f.snapshot().activeRecords,1);await f.retryPromptReaderCleanups();assert.equal(response.body.locked,false);assert.equal(unlocks,2);assert.equal(f.snapshot().activeRecords,0);
});
test('RecoveryWorkspace releases native terminal network errors and admits a later recovery read',async()=>{
 const f=await fixture(),workspace=new f.RecoveryWorkspace(),cause=new TypeError('recovery network interrupted'),response=await workspace.request(async()=>errored(cause),'/fixture');
 const result=await observe((async()=>{for await(const _ of workspace.chunks(response)){} })());assert.equal(result.error,cause);assert.equal(response.body.locked,false);await workspace.release();assert.equal(f.snapshot().activeRecords,0);
 const next=new f.RecoveryWorkspace(),good=await next.request(async()=>new Response('x'),'/fixture');let size=0;for await(const chunk of next.chunks(good))size+=chunk.length;assert.equal(size,1);await next.release();assert.equal(f.snapshot().activeRecords,0);
});
test('RecoveryWorkspace keeps a real underlying cancellation failure charged',async()=>{
 const f=await fixture(),workspace=new f.RecoveryWorkspace(),cause=new TypeError('cancel failure');let calls=0;const response=await workspace.request(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));},cancel(){calls++;throw cause;}})),'/fixture');
 await assert.rejects((async()=>{for await(const _ of workspace.chunks(response))break;})(),/RECOVERY_RELEASE_UNCONFIRMED/);await assert.rejects(workspace.release(),/RECOVERY_RELEASE_UNCONFIRMED/);assert.equal(calls,1);assert.equal(response.body.locked,false);assert.equal(f.snapshot().unusedHandles,2);
});
test('display source and raw tile descriptors release native terminal network errors without sticky cleanup',async()=>{
 const f=await fixture(),{preview,tiles}=await displayModules(f);
 const p=await import(preview),t=await import(tiles),cause=new TypeError('display network interrupted'),responses=[];const transport=async()=>{const response=errored(cause);responses.push(response);return response;};
 assert.equal((await observe(p.readDisplaySource(transport,'asset',{owner:'stream-fixture'}))).error,cause);await p.waitForDisplayPreviewReads();assert.equal(p.displayPreviewOwnership().cleanupFailures,0);
 assert.equal((await observe(t.readDisplaySource(transport,'asset',1,1,new AbortController().signal))).error,cause);assert.equal(t.displaySourceCleanupOwnership().pendingCleanup,0);assert(responses.every(response=>!response.body.locked));assert.equal(f.snapshot().activeRecords,0);
 // A later complete schema-2 projection must traverse the real compiled asset
 // validator successfully; the failed native stream cannot poison admission.
 const asset=canonicalDisplayAsset({id:'asset'}),value=assetProjection(asset),valid=async()=>{const response=Response.json(value);responses.push(response);return response;};
 const previewSource=await p.readDisplaySource(valid,'asset',{owner:'stream-fixture'});assert.equal(previewSource.assetId,'asset');assert.equal(previewSource.identity,asset.raster.pixelIdentity);
 assert.deepEqual(await t.readDisplaySource(valid,'asset',1,1,new AbortController().signal),{assetId:'asset',identity:asset.raster.pixelIdentity,width:1,height:1});
 await assert.rejects(p.readDisplaySource(async()=>Response.json({...value,projectionSchema:99}),'asset',{owner:'stream-fixture'}),/Unsupported asset projection/);
 await assert.rejects(t.readDisplaySource(valid,'asset',2,1,new AbortController().signal),/DISPLAY_SOURCE_CHANGED/);
 await p.waitForDisplayPreviewReads();assert.equal(p.displayPreviewOwnership().cleanupFailures,0);assert.equal(t.displaySourceCleanupOwnership().pendingCleanup,0);assert(responses.every(response=>!response.body.locked));assert.equal(f.snapshot().activeRecords,0);
});
test('same-stack recovery stream error then cancellation does not cache a false cleanup failure',async()=>{
 const f=await fixture(),workspace=new f.RecoveryWorkspace(),cause=new TypeError('same-stack network error');let source;
 const response=await workspace.request(async()=>new Response(new ReadableStream({start(controller){source=controller;}})),'/fixture'),iterator=workspace.chunks(response),next=iterator.next();
 await Promise.resolve();source.error(cause);workspace.cancel();const result=await observe(next);assert.equal(result.rejected,true);assert(!(result.error instanceof f.RecoveryCleanupError));await workspace.release();assert.equal(response.body.locked,false);assert.equal(f.snapshot().activeRecords,0);
});
test('stale prompt and aborted recovery acquire and unlock an already errored response without sticky cleanup',async()=>{
 const f=await fixture(),cause=new TypeError('response already failed'),signal=new AbortController();signal.abort();const response=errored(cause);
 const prompt=await observe(f.readRetainedPrompt(response,1,()=>true,signal.signal));assert.equal(prompt.rejected,true);assert(!(prompt.error instanceof f.PromptReaderCleanupError));assert.equal(response.body.locked,false);await f.retryPromptReaderCleanups();
 const workspace=new f.RecoveryWorkspace(),late=errored(cause),request=workspace.request(async()=>{workspace.cancel();return late;},'/fixture');await assert.rejects(request,error=>error.name==='AbortError');await workspace.release();assert.equal(late.body.locked,false);assert.equal(f.snapshot().activeRecords,0);
});
test('a true source cancellation rejecting AbortError stays charged when the signal was aborted',async()=>{
 const f=await fixture(),signal=new AbortController(),cause=new DOMException('source cleanup did not finish','AbortError');let started;const ready=new Promise(resolve=>{started=resolve;}),response=new Response(new ReadableStream({pull(){started();},cancel(){throw cause;}}));
 const work=f.readRetainedPrompt(response,1,()=>true,signal.signal);await ready;signal.abort();const result=await observe(work);assert(result.error instanceof f.PromptReaderCleanupError);assert.equal(result.error.cancellationFailed,true);assert.equal(response.body.locked,false);await assert.rejects(f.retryPromptReaderCleanups(),/PROMPT_READER_CLEANUP_INCOMPLETE/);assert.equal(f.snapshot().unusedHandles,2);
});
test('tile response cancellation before reader acquisition releases an already errored body',async()=>{
 const f=await fixture(),{tiles}=await displayModules(f),t=await import(tiles),signal=new AbortController(),response=errored(new TypeError('network failed before acquisition'));
 await assert.rejects(t.readDisplaySource(async()=>{signal.abort();return response;},'asset',1,1,signal.signal),error=>error.name==='AbortError');assert.equal(t.displaySourceCleanupOwnership().pendingCleanup,0);assert.equal(response.body.locked,false);assert.equal(f.snapshot().activeRecords,0);
});

import {viewModelDependencies} from '../view-model-module.mjs';
import {draftStateDependencies} from '../draft-state-module.mjs';
import {allocationsURL as allocationURL,isolatedDiagnosticModules} from '../owned-preview-module.mjs';
// Source-only staging: these tests are authored for the promoted tree and have
// not been executed. Optional roots make deliberate staging qualification clear.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
const root=process.env.ALLOCATION_CLOSURE_ROOT??'.',shared=process.env.ALLOCATION_SHARED_ROOT??'.';
const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
async function moduleURL(path,imports={}){let source=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))source=source.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(source);}
const promptURL=await moduleURL(shared+'/src/observability/prompt-memory.ts',{'./allocations.js':allocationURL});
const memoryURL=await moduleURL(root+'/src/observability/model-memory.ts',{'./allocations.js':allocationURL,'./prompt-memory.js':promptURL});
const documentsURL=await moduleURL(root+'/src/state/document-list.ts',{'../observability/model-memory.js':memoryURL});
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationURL);
const {modelPayloadBytes,cloneOwnedModel,readOwnedJSON}=await import(memoryURL);
const {collectOwnedDocuments,DOCUMENT_LIST_LIMITS,DocumentListAdmissionError}=await import(documentsURL);
const response=value=>{const text=JSON.stringify(value);return new Response(text,{headers:{'content-length':String(new TextEncoder().encode(text).length)}});};
const cache=(rows,published=()=>({generation:'g',cursor:'9'}))=>({published:async()=>published(),async *rows(){yield* rows.map(value=>({value}));},close(){}});

test('model admission and async pins remain live until every borrower releases',()=>{
  const before=allocationLedger.snapshot(),value={name:'review',geometry:[1,2,3],ready:true},owned=cloneOwnedModel('model-fixture',value),unpin=owned.pin();
  assert.notEqual(owned.value,value);assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,modelPayloadBytes(value));
  owned.release();owned.release();assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,modelPayloadBytes(value));unpin();unpin();assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
});
test('owned JSON keeps retained model payload after parser workspace drains',async()=>{
  const before=allocationLedger.snapshot(),value={page:[{id:'one',count:4}]};
  const result=await readOwnedJSON(async()=>response(value),'/fixture',{owner:'json-fixture'});
  assert.deepEqual(result.value,value);assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,modelPayloadBytes(value));result.release();assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords);
});
// Native Response permits a null body for status 204. Browser transports can
// instead expose a native empty stream, represented by this response shape.
const streamed204=body=>({status:204,ok:true,headers:new Headers(),body});
const sameModelUsage=(actual,before)=>{for(const key of ['cpuBytes','promptBytes','handles','activeRecords','unusedHandles'])assert.equal(actual[key],before[key],key);};
test('owned JSON preserves the native Response 204 null-body fast path and retained zero-byte ownership',{timeout:10000},async()=>{
  const before=allocationLedger.snapshot(),received=new Response(null,{status:204});
  const owned=await readOwnedJSON(async()=>received,'/empty',{owner:'json-native-204'});
  try{
    assert.equal(received.status,204);assert.equal(received.body,null);assert.equal(received.headers.get('content-length'),null);
    assert.equal(owned.value,undefined);assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
    assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords+1);assert.equal(allocationLedger.snapshot().handles,before.handles+1);
  }finally{owned.release();}
  sameModelUsage(allocationLedger.snapshot(),before);
});
test('owned JSON drains an actual empty 204 stream through EOF and unlock before retaining the undefined model',{timeout:10000},async()=>{
  const before=allocationLedger.snapshot(),entered=Promise.withResolvers();let controller,cancels=0,finished=false;
  const body=new ReadableStream({start(value){controller=value;},pull(){entered.resolve();},cancel(){cancels++;}},{highWaterMark:0});
  const response=streamed204(body),pending=readOwnedJSON(async()=>response,'/empty',{owner:'json-streamed-204',maxBytes:0});
  void pending.then(()=>{finished=true;},()=>{finished=true;});
  let owned,unpin,closed=false;
  try{
    await Promise.race([entered.promise,pending.then(()=>{throw Error('204 model returned before native EOF');})]);
    assert.equal(response.headers.has('content-length'),false);assert.equal(body.locked,true);assert.equal(finished,false);
    assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords+1);assert.equal(allocationLedger.snapshot().handles,before.handles+2);
    controller.close();closed=true;owned=await pending;
    assert.equal(body.locked,false);assert.equal(cancels,0);assert.equal(owned.value,undefined);unpin=owned.pin();
    owned.release();assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
    assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords+1);assert.equal(allocationLedger.snapshot().handles,before.handles+1);
  }finally{
    if(!closed){if(body.locked)controller.close();else await body.cancel();}
    (owned??await pending.catch(()=>undefined))?.release();unpin?.();
  }
  sameModelUsage(allocationLedger.snapshot(),before);
});
test('owned JSON refuses unexpected 204 bytes and confirms native cancellation and unlock',{timeout:10000},async()=>{
  const before=allocationLedger.snapshot();let cancels=0;
  const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array([123]));},cancel(){cancels++;}},{highWaterMark:0});
  await assert.rejects(readOwnedJSON(async()=>streamed204(body),'/nonempty',{owner:'json-nonempty-204'}),/PROMPT_CONTENT_SIZE/);
  assert.equal(cancels,1);assert.equal(body.locked,false);sameModelUsage(allocationLedger.snapshot(),before);
});
test('owned JSON cancels a native 204 stream when its owner is superseded during the read',{timeout:10000},async()=>{
  const before=allocationLedger.snapshot(),entered=Promise.withResolvers();let controller,owns=true,cancels=0;
  const body=new ReadableStream({start(value){controller=value;},pull(){entered.resolve();},cancel(){cancels++;}},{highWaterMark:0});
  const pending=readOwnedJSON(async()=>streamed204(body),'/stale',{owner:'json-stale-204',owns:()=>owns}),rejected=assert.rejects(pending,/PROMPT_READ_STALE/);
  try{
    await Promise.race([entered.promise,rejected.then(()=>{throw Error('204 read ended before owner supersession');})]);assert.equal(body.locked,true);owns=false;controller.enqueue(new Uint8Array(0));await rejected;
    assert.equal(cancels,1);assert.equal(body.locked,false);
  }finally{owns=false;if(body.locked)controller.close();(await pending.catch(()=>undefined))?.release();await rejected.catch(()=>{});}
  sameModelUsage(allocationLedger.snapshot(),before);
});
test('owned JSON rechecks ownership after successful native 204 EOF and unlock',{timeout:10000},async()=>{
  const before=allocationLedger.snapshot();let owns=true,unlocks=0,cancels=0;
  const body=new ReadableStream({pull(controller){controller.close();},cancel(){cancels++;}},{highWaterMark:0}),getReader=body.getReader.bind(body);
  // Only the external owner's transition at successful unlock is controlled;
  // read, EOF and releaseLock still run the native stream implementation.
  body.getReader=()=>{const reader=getReader(),release=reader.releaseLock.bind(reader);reader.releaseLock=()=>{release();unlocks++;owns=false;};return reader;};
  await assert.rejects(readOwnedJSON(async()=>streamed204(body),'/stale-after-eof',{owner:'json-completed-204',owns:()=>owns}),error=>error instanceof DOMException&&error.name==='AbortError');
  assert.equal(unlocks,1);assert.equal(cancels,0);assert.equal(body.locked,false);sameModelUsage(allocationLedger.snapshot(),before);
});
test('owned JSON retains a failed native 204 cancellation and its actual lease in an isolated real ledger',{timeout:10000},async()=>{
  const graph=await isolatedDiagnosticModules(),isolatedPromptURL=await moduleURL(shared+'/src/observability/prompt-memory.ts',{'./allocations.js':graph.allocationsURL});
  const isolatedMemoryURL=await moduleURL(root+'/src/observability/model-memory.ts',{'./allocations.js':graph.allocationsURL,'./prompt-memory.js':isolatedPromptURL});
  const {allocationLedger:ledger}=await import(graph.allocationsURL),prompt=await import(isolatedPromptURL),{readOwnedJSON:read}=await import(isolatedMemoryURL),before=ledger.snapshot();
  const cause=Error('NATIVE_204_CANCEL_FAILED');let owns=true,cancels=0,reader,failure;
  const body=new ReadableStream({cancel(){cancels++;throw cause;}},{highWaterMark:0}),getReader=body.getReader.bind(body),response=streamed204(body);
  body.getReader=()=>reader=getReader();
  await assert.rejects(read(async()=>{owns=false;return response;},'/cancel-fails',{owner:'json-cancel-failure-204',owns:()=>owns}),error=>{failure=error;return error instanceof prompt.PromptReaderCleanupError;});
  assert.equal(failure.cancellationFailed,true);assert.equal(failure.resource.response,response);assert.equal(failure.resource.retainedReader,reader);
  assert.equal(failure.resource.reader,undefined);assert.ok(failure.resource.cancellation instanceof Promise);assert.ok(failure.resource.lease);
  assert.equal(failure.errors[0].message,'PROMPT_READ_STALE');assert.equal(failure.errors[1],cause);assert.equal(cancels,1);assert.equal(body.locked,false);
  assert.deepEqual(prompt.promptReaderCleanupFailures(),[failure]);
  assert.equal(ledger.snapshot().activeRecords,before.activeRecords+1);assert.equal(ledger.snapshot().unusedHandles,before.unusedHandles+2);
  await assert.rejects(failure.retry(),error=>error===failure);await assert.rejects(prompt.retryPromptReaderCleanups(),/PROMPT_READER_CLEANUP_INCOMPLETE/);
  assert.equal(cancels,1);assert.equal(ledger.snapshot().activeRecords,before.activeRecords+1);assert.equal(ledger.snapshot().unusedHandles,before.unusedHandles+2);
  // A rejected native cancellation never supplies a cleanup receipt. This
  // isolated graph deliberately keeps the response, reader and charged lease.
});
test('prompt-bearing JSON remains in the prompt partition through retained ownership',async()=>{
  const before=allocationLedger.snapshot(),value={bytes:'YQ==',offset:'0'};
  const result=await readOwnedJSON(async()=>response(value),'/fixture',{owner:'json-prompt-fixture',kind:'prompt'});
  assert.equal(allocationLedger.snapshot().promptBytes-before.promptBytes,modelPayloadBytes(value));result.release();assert.equal(allocationLedger.snapshot().promptBytes,before.promptBytes);
});
test('owned JSON rejects oversized declared bodies before reading and cancels them',async()=>{
  const before=allocationLedger.snapshot();let cancelled=0;
  const body=new ReadableStream({cancel(){cancelled++;}});
  await assert.rejects(readOwnedJSON(async()=>new Response(body,{headers:{'content-length':'5'}}),'/fixture',{owner:'json-fixture',maxBytes:4}),/PROMPT_CONTENT_SIZE/);
  assert.equal(cancelled,1);assert.equal(body.locked,false);assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords);
});
test('owned JSON admission refuses before invoking transport',async()=>{
  const blockers=[];let fetched=false;
  try{while(allocationLedger.snapshot().activeRecords<ALLOCATION_LIMITS.records)blockers.push(allocationLedger.reserve({owner:'model-fixture-blocker',kind:'control'}));
    await assert.rejects(readOwnedJSON(async()=>{fetched=true;return response({});},'/fixture',{owner:'json-fixture'}),/ALLOCATION_BUDGET/);assert.equal(fetched,false);
  }finally{for(const blocker of blockers)blocker.release();}
});
test('document scan publishes only a whole unchanged generation',async()=>{
  const before=allocationLedger.snapshot(),rows=[{id:'one',revision:'1'},{id:'two',revision:'2'}],pointer={generation:'g',cursor:'9',epoch:'1'},owned=await collectOwnedDocuments(cache(rows,()=>pointer));
  assert.deepEqual(owned.publication,pointer);assert.notEqual(owned.publication,pointer);assert.equal(Object.isFrozen(owned.publication),true);pointer.cursor='10';assert.equal(owned.publication.cursor,'9');
  assert.deepEqual(owned.documents,rows);assert.equal(owned.cursor,'9');assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,modelPayloadBytes(rows));owned.release();
  let publication=0;const changed=await collectOwnedDocuments(cache(rows,()=>({generation:++publication===1?'a':'b',cursor:'2'})));assert.equal(changed,null);assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords);
});
test('document scan refuses a complete list above its count bound and drains partial owners',async()=>{
  const before=allocationLedger.snapshot();let closed=false;
  const many={published:async()=>({generation:'g',cursor:'1'}),async *rows(){try{for(let i=0;i<=DOCUMENT_LIST_LIMITS.documents;i++)yield {value:{id:String(i)}};}finally{closed=true;}}};
  await assert.rejects(collectOwnedDocuments(many),DocumentListAdmissionError);assert.equal(closed,true);assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords);
});
test('document scan releases its first reservation if cursor admission fails',async()=>{
  const before=allocationLedger.snapshot(),blocker=allocationLedger.reserve({owner:'document-fixture-blocker',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-before.cpuBytes});
  try{await assert.rejects(collectOwnedDocuments(cache([])),/ALLOCATION_BUDGET/);assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords+1);}finally{blocker.release();}
});

const resourceURL=await moduleURL('src/state/document-lifecycle.ts');
const {viewURL}=await viewModelDependencies(allocationURL,{memoryURL,promptURL});
const {commandsURL}=await draftStateDependencies(allocationURL,{memoryURL,promptURL});
const clientSource=(await transformWithOxc(await readFile(root+'/src/state/editor-client.ts','utf8'),'editor-client.ts')).code.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];?\n/gm,'');
const {EditorClient}=await import(data(`import {ViewModelOwners,ViewModelReads,canonicalControlHash,VIEW_MODEL_LIMITS,ownDownload} from ${JSON.stringify(viewURL)};import {CommandControlReads} from ${JSON.stringify(commandsURL)};import {allocationLedger} from ${JSON.stringify(allocationURL)};import {readOwnedJSON} from ${JSON.stringify(memoryURL)};import {collectOwnedDocuments} from ${JSON.stringify(documentsURL)};import {DocumentResources} from ${JSON.stringify(resourceURL)};
const createValueModel=initial=>{let value=initial;return {value:{get:()=>value},set:next=>{value=next;}};};const browserPhases={resetNavigation(){},reset(){}};\n`+clientSource));
test('EditorClient refusal preserves the exact previous complete list and current row ownership',async()=>{
  const before=allocationLedger.snapshot(),client=new EditorClient({identity:()=> 'model-memory-fixture',transport:async()=>{throw Error('Unexpected transport');}});
  const controls=allocationLedger.snapshot().cpuBytes-before.cpuBytes;
  assert.equal(controls,modelPayloadBytes(client.renderViewMetadata(client.view).value)+'editor-view-metadata'.length*2+3*8,'one exact metadata payload plus its three-reference ownership index');
  client.cache=cache([{id:'one',revision:'1'}]);await client.refresh();const original=client.view.documents,originalBytes=allocationLedger.snapshot().cpuBytes-before.cpuBytes;client.patch({document:original[0]});
  client.cache={published:async()=>({generation:'g',cursor:'2'}),async *rows(){for(let i=0;i<=DOCUMENT_LIST_LIMITS.documents;i++)yield {value:{id:String(i)}};},close(){}};
  await assert.rejects(client.refresh(),DocumentListAdmissionError);assert.equal(client.view.documents,original);assert.equal(client.view.document,original[0]);assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,originalBytes);
  // A current image probe can refuse a newer row. Its old active row must keep
  // the former list owner alive while the complete new list is displayed.
  client.cache=cache([{id:'one',revision:'2'}]);client.loadDocument=async()=>{};await client.refresh();const replacement=client.view.documents;
  assert.equal(client.view.document,original[0]);assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,controls+modelPayloadBytes(original)+modelPayloadBytes(replacement));
  client.patch({document:replacement[0]});assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,controls+modelPayloadBytes(replacement));client.dispose();await Promise.resolve();assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
});

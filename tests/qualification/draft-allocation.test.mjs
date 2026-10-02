import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {allocationsURL,promptMemoryURL,allocationDeltaSnapshot,isolatedDiagnosticModules} from '../owned-preview-module.mjs';
import {draftStateDependencies,jsonResponse,discardOwned} from '../draft-state-module.mjs';

const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function module(path,replacements={}){
 let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;
 for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
 return data(code);
}
const promptURL=promptMemoryURL,{draftURL}=await draftStateDependencies(allocationsURL,{promptURL});
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL);
const {jsonStringUnits,jsonPayloadUnits,reservePromptJSON,readRetainedPrompt}=await import(promptURL);
const {DraftPersistence}=await import(draftURL);
const save=async(owner,id,prepare)=>discardOwned(owner.ownedSave(id,prepare));
const pendingGates=new Set();const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});pendingGates.add(resolve);return {promise,resolve,reject};};
const cleanups=[];
function cleanup(t,release){let task;const once=()=>task??=Promise.resolve().then(release);cleanups.push(once);t.after(once);}
const input=(text,overrides={})=>({id:'draft',kind:'prompt',documentId:'document',targetLayerId:null,expectedDocumentRevision:'1',composing:false,text,...overrides});
const saved=(id='draft',documentId='document')=>({id,kind:'prompt',documentId,targetLayerId:null,expectedDocumentRevision:'1',composing:false,generation:'7',assetId:'caption-'+id,status:'saved-unapplied'});
function fixture(t){
 const posts=[];let seq=0,status='accepted';
 const owner=new DraftPersistence('ui',async(_path,init)=>{
  assert.equal(init?.method,'POST','The fixture only accepts explicit UI deliveries');
  const request=JSON.parse(init.body);posts.push(request);
  return jsonResponse({protocolVersion:1,requestId:request.requestId,status,uiSeq:String(++seq),reason:status==='rejected'?'UI_CONFLICT':null});
 },()=> 'csrf');
 owner.checkpoint={sessionId:'ui',uiSeq:'0',preferences:{documentId:'document'},drafts:[],reconciledLayerIds:[]};
 cleanup(t,()=>owner.dispose());
 return {owner,posts,rejectReceipts:()=>{status='rejected';}};
}
function pressure(t,availableBytes){
 // Reserve bookkeeping only, so a real 64 MiB partition boundary can be tested
 // without constructing a giant string or replacing the admission implementation.
 const lease=allocationLedger.reserve({owner:'test-prompt-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-availableBytes});
 cleanup(t,()=>lease.release());return lease;
}
const snapshot=allocationDeltaSnapshot(allocationLedger);
test.afterEach(async()=>{
 // Node runs suite afterEach before per-test after hooks. Drain owned fixtures
 // first, while keeping each t.after as an idempotent failure-path fallback.
 for(const resolve of pendingGates)resolve();pendingGates.clear();
 while(cleanups.length)await cleanups.pop()();
 assert.equal(snapshot().activeRecords,0,'Every draft, outgoing save and pressure lease is released');
 assert.equal(snapshot().promptBytes,0);
});

test('retained draft payload charges UTF-16 units and document release refunds saved text',async t=>{
 const {owner,posts}=fixture(t),text='A😀\ud800';
 assert.equal(owner.change(input(text)),'1');
 assert.equal(snapshot().promptBytes,text.length*2);
 assert.equal(snapshot().byKind.prompt.cpuBytes,text.length*2);
 assert.throws(()=>owner.releaseDocument('document'),/Save the current drafts/);
 assert.equal(snapshot().promptBytes,text.length*2);
 await save(owner,'draft',async value=>{assert.equal(value,text);return 'caption';});
 assert.equal(posts.length,1);assert.equal(owner.drafts.get('draft').savedGeneration,'1');
 assert.equal(snapshot().promptBytes,text.length*2,'The outgoing save pin is gone after its receipt');
 owner.releaseDocument('document');
 assert.equal(owner.drafts.size,0);assert.equal(snapshot().promptBytes,0);
});

test('replacing unpinned text resizes one retained lease, and clearing the map releases all kinds',t=>{
 const {owner}=fixture(t);
 owner.change(input('old'));
 owner.change(input('😀'));
 owner.change(input('text workspace',{id:'native',kind:'text'}));
 assert.equal([...allocationLedger.entries.values()].filter(row=>row.owner==='draft-retained-text').length,2);assert.equal(owner.drafts.inspect().currentRows,2);
 assert.equal(snapshot().promptBytes,('😀'.length+'text workspace'.length)*2);
 owner.drafts.delete('draft');assert.equal(snapshot().promptBytes,'text workspace'.length*2);
 owner.drafts.clear();assert.equal(snapshot().promptBytes,0);assert.equal(owner.drafts.inspect().retainedRows,0);assert(snapshot().activeRecords>0,'The retained UI checkpoint remains owned');
});

test('a refused change keeps the saved generation, blocks save and close, and a smaller edit recovers',async t=>{
 const {owner,posts}=fixture(t);
 owner.change(input('old'));await save(owner,'draft',async()=> 'old-caption');
 const occupied=pressure(t,10),prior=owner.drafts.get('draft');
 assert.throws(()=>owner.change(input('large')),/PROMPT_MEMORY_BUDGET/);
 assert.equal(owner.drafts.get('draft').text,'old');assert.equal(owner.drafts.get('draft').generation,prior.generation);
 assert.equal(owner.drafts.get('draft').savedGeneration,'1');assert.equal(owner.hasRefusedChanges,true);
 assert.equal(snapshot().promptBytes,ALLOCATION_LIMITS.promptBytes-4);
 let prepared=0;
 await assert.rejects(save(owner,'draft',async()=>{prepared++;return 'must-not-save';}),/Draft workspace is full/);
 assert.equal(prepared,0);assert.equal(posts.length,1);
 assert.throws(()=>owner.assertDocumentSaved('document'),/Draft workspace is full/);
 assert.throws(()=>owner.releaseDocument('document'),/Draft workspace is full/);
 assert.equal(owner.change(input('ok')),'2');assert.equal(owner.hasRefusedChanges,false);
 await save(owner,'draft',async text=>{assert.equal(text,'ok');assert.equal(snapshot().promptBytes,ALLOCATION_LIMITS.promptBytes-6,'The save borrows the real text owner without a duplicate payload copy');return 'new-caption';});
 owner.releaseDocument('document');assert.equal(snapshot().promptBytes,ALLOCATION_LIMITS.promptBytes-10);
 occupied.release();assert.equal(snapshot().promptBytes,0);
});

test('an explicitly refused first input blocks its document without retaining the rejected string',async t=>{
 const {owner}=fixture(t);
 const releaseEditable=owner.registerDraft('draft','document');cleanup(t,releaseEditable);owner.refuseChange('draft','document');
 assert.equal(owner.drafts.size,0);assert.equal(snapshot().promptBytes,0);assert(snapshot().activeRecords>0,'The editable refusal identity and checkpoint have actual bounded owners');
 assert.throws(()=>owner.assertDocumentSaved('document'),/Draft workspace is full/);
 assert.doesNotThrow(()=>owner.assertDocumentSaved('other-document'));
 await assert.rejects(save(owner,'draft',async()=> 'caption'),/Draft workspace is full/);
 owner.change(input('accepted'));await save(owner,'draft',async()=> 'caption');
 assert.equal(owner.hasRefusedChanges,false);owner.releaseDocument('document');
});

test('accepted ClearDraft releases its retained payload and refusal; rejected ClearDraft keeps both',async t=>{
 const accepted=fixture(t),rejected=fixture(t);rejected.rejectReceipts();
 for(const {owner}of [accepted,rejected]){owner.change(input('kept'));owner.refuseChange('draft','document');}
 const clear=owner=>discardOwned(owner.ownedDispatch({protocolVersion:1,requestId:crypto.randomUUID(),sessionId:'ui',expectedUISeq:'0',body:{type:'ClearDraft',draftId:'draft',generation:'1'}}));
 await clear(rejected.owner);
 assert.equal(rejected.owner.drafts.get('draft').text,'kept');assert.equal(rejected.owner.hasRefusedChanges,true);
 assert.equal(snapshot().promptBytes,16);
 await clear(accepted.owner);
 assert.equal(accepted.owner.drafts.size,0);assert.equal(accepted.owner.hasRefusedChanges,false);
 assert.equal(snapshot().promptBytes,8);
 await rejected.owner.dispose();assert.equal(snapshot().promptBytes,0);
});

test('an asynchronous save pins the old generation while a new generation takes its retained lease',async t=>{
 const {owner,posts}=fixture(t),gate=deferred();pressure(t,16);
 // A save pins the actual retained text rather than making a duplicate.
 // Replacement owns new text while the old generation remains borrowed.
 owner.change(input('old!'));
 const pending=save(owner,'draft',async text=>{assert.equal(text,'old!');return gate.promise;});
 assert.equal(snapshot().promptBytes,ALLOCATION_LIMITS.promptBytes-8);
 const next=owner.change(input('ok'));
 assert.equal(snapshot().promptBytes,ALLOCATION_LIMITS.promptBytes-4,'The old outgoing pin remains charged beside the new four-byte draft');
 assert.equal(owner.drafts.get('draft').text,'ok');assert.equal(owner.drafts.get('draft').generation,next);
 gate.resolve('old-caption');await pending;
 assert.equal(posts.length,0,'A superseded generation cannot publish a SaveDraft request');
 assert.equal(owner.drafts.get('draft').savedGeneration,null);
 assert.equal(snapshot().promptBytes,ALLOCATION_LIMITS.promptBytes-12);
 await save(owner,'draft',async()=> 'new-caption');owner.releaseDocument('document');
});

test('failed outgoing preparation drops its old-generation pin without refunding replacement text',async t=>{
 const {owner,posts}=fixture(t),gate=deferred();
 owner.change(input('older'));
 const pending=save(owner,'draft',()=>gate.promise),rejected=assert.rejects(pending,/STORAGE_FULL/);
 assert.equal(snapshot().promptBytes,10,'Borrowing the original generation does not duplicate text');
 owner.change(input('new'));assert.equal(snapshot().promptBytes,16);
 gate.reject(Error('STORAGE_FULL'));await rejected;
 assert.equal(snapshot().promptBytes,6);assert.equal(owner.drafts.get('draft').text,'new');assert.equal(posts.length,0);
});

test('invalidate changes draft ownership but does not refund text that remains retained',async t=>{
 const {owner}=fixture(t);owner.change(input('retained'));await save(owner,'draft',async()=> 'caption');
 const before=snapshot();owner.invalidate();
 assert.equal(owner.drafts.get('draft').text,'retained');assert.equal(owner.drafts.get('draft').generation,'2');
 assert.equal(owner.drafts.get('draft').savedGeneration,null);
 assert.equal(snapshot().promptBytes,before.promptBytes);assert.equal(snapshot().activeRecords,before.activeRecords);
 assert.throws(()=>owner.releaseDocument('document'),/Save the current drafts/);
});

test('restoring saved text charges its exact payload and releases only the selected document',async t=>{
 const {owner}=fixture(t);owner.checkpoint={...owner.checkpoint,drafts:[saved(),saved('other','other-document')]};
 await owner.restoreDraft('draft',async asset=>{assert.equal(asset,'caption-draft');return '😀';});
 await owner.restoreDraft('other',async()=> 'other');
 assert.equal(snapshot().promptBytes,14);assert.equal(owner.drafts.get('draft').savedGeneration,'7');
 owner.releaseDocument('document');assert.equal(snapshot().promptBytes,10);assert.equal(owner.drafts.has('other'),true);
 owner.releaseDocument('other-document');assert.equal(snapshot().promptBytes,0);
});

test('a stale restore checks ownership before attempting a new lease at a full partition',async t=>{
 const {owner}=fixture(t),gate=deferred();owner.checkpoint={...owner.checkpoint,drafts:[saved()]};
 const pending=owner.restoreDraft('draft',()=>gate.promise);owner.invalidate();pressure(t,0);
 const before=snapshot();gate.resolve('stale text');await pending;
 assert.equal(owner.drafts.size,0);assert(snapshot().activeRecords<=before.activeRecords,'The stale read releases its checkpoint and alias pins without new admission');
 assert.equal(snapshot().refusals,before.refusals,'No stale admission was even attempted');
});

test('dispose releases retained text and fences late restoration and subsequent owner calls',async t=>{
 const {owner}=fixture(t),gate=deferred();owner.checkpoint={...owner.checkpoint,drafts:[saved(),saved('late')]};
 await owner.restoreDraft('draft',async()=> 'retained');
 const pending=owner.restoreDraft('late',()=>gate.promise);assert.equal(snapshot().promptBytes,16);
 const drain=owner.dispose();assert.equal(snapshot().promptBytes,0);assert.equal(owner.drafts.size,0);assert.equal(owner.checkpoint,null);
 gate.resolve('must not return');await pending;await drain;assert.equal(snapshot().activeRecords,0);
 assert.throws(()=>owner.change(input('new')),/DRAFT_OWNER_DISPOSED/);
 await assert.rejects(owner.restoreDraft('draft',async()=> 'new'),/DRAFT_OWNER_DISPOSED/);
 await assert.rejects(owner.restore(),/DRAFT_OWNER_DISPOSED/);
 await assert.rejects(save(owner,'draft',async()=> 'caption'),/DRAFT_OWNER_DISPOSED/);
});

test('JSON string admission counts quotes, controls and paired or unmatched surrogates exactly',()=>{
 const strings=['','plain ASCII','"quoted"\\path','\b\t\n\f\r','\u0000\u0001\u001f','é中\u2028\u2029','😀','\ud800','\udfff','\ud800x\udc00','\ud800\ud800\udc00\udfff'];
 for(const value of strings){assert.equal(jsonStringUnits(value),JSON.stringify(value).length,JSON.stringify(value));assert.equal(jsonPayloadUnits(value),JSON.stringify(value).length);}
});

test('JSON payload allowance covers nested arrays, object escaping, absent fields and finite-number extremes',()=>{
 const exact=[null,true,false,[],{},['"',null,undefined,,false],{'key"\n':'value\ud800',nested:[{'😀':'\\'}],absent:undefined}];
 for(const value of exact)assert.equal(jsonPayloadUnits(value),JSON.stringify(value).length);
 const values=[0,-0,1,-1,Number.MIN_VALUE,Number.MAX_VALUE,Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,1e-7,1e21,-1.2345678901234567e-300,Infinity,-Infinity,NaN];
 for(const value of values){const expected=JSON.stringify(value).length;assert.ok(jsonPayloadUnits(value)>=expected,String(value));}
 const inherited=Object.create({notOwn:'omit'});inherited.present=[...values,{number:Number.MAX_VALUE}];
 assert.ok(jsonPayloadUnits(inherited)>=JSON.stringify(inherited).length);
});

test('JSON reservations use the same prompt partition and refuse before a serialization-sized copy',t=>{
 const value={prompt:'"\ud800😀\n'},bytes=jsonPayloadUnits(value)*2;
 const occupied=pressure(t,bytes),lease=reservePromptJSON('test-json-workspace',value);t.after(()=>lease.release());
 assert.equal(snapshot().promptBytes,ALLOCATION_LIMITS.promptBytes);
 assert.throws(()=>reservePromptJSON('test-json-overflow',value),/PROMPT_MEMORY_BUDGET/);
 lease.release();occupied.release();assert.equal(snapshot().promptBytes,0);
});

test('retained prompt decoding owns exactly two bytes per UTF-16 unit across Unicode chunk boundaries',async t=>{
 const text='\ufeffAé中😀\n',bytes=new TextEncoder().encode(text);let offset=0,admitted;
 const body=new ReadableStream({pull(controller){
  admitted??=snapshot();
  if(offset===bytes.length)controller.close();else controller.enqueue(bytes.slice(offset,++offset));
 }},{highWaterMark:0});
 const retained=await readRetainedPrompt(new Response(body,{headers:{'content-length':String(bytes.length)}}),bytes.length,()=>true);
 t.after(()=>retained.lease.release());
 assert.equal(admitted.promptBytes,bytes.length*4,'Admission precedes the first stream pull');
 assert.equal(retained.text,text,'Fatal streaming UTF-8 decoding preserves Unicode and an explicit BOM');
 assert.equal(snapshot().promptBytes,text.length*2);assert.equal(snapshot().activeRecords,1);
 assert.equal(snapshot().byKind.prompt.handles,1);assert.equal(body.locked,false);
 retained.lease.release();retained.lease.release();assert.equal(snapshot().promptBytes,0);
});

for(const [name,expectedBytes,bodyBytes]of [['extra',2,3],['truncated',4,3]])test('declared '+name+' prompt bytes reject and release their stream lease',async()=>{
 let sent=false,cancels=0;
 const body=new ReadableStream({pull(controller){if(sent)controller.close();else{sent=true;controller.enqueue(new Uint8Array(bodyBytes).fill(65));}},cancel(){cancels++;}},{highWaterMark:0});
 await assert.rejects(readRetainedPrompt(new Response(body,{headers:{'content-length':String(expectedBytes)}}),expectedBytes,()=>true),/PROMPT_CONTENT_SIZE/);
 assert.equal(snapshot().promptBytes,0);assert.equal(snapshot().activeRecords,0);assert.equal(body.locked,false);
 if(name==='extra')assert.equal(cancels,1,'An oversized still-open body is canceled');
});

test('ownership lost during an awaited prompt read cancels the stream and releases every reservation',async()=>{
 const entered=deferred();let controller,owns=true,cancels=0;
 const body=new ReadableStream({start(value){controller=value;},pull(){entered.resolve();},cancel(){cancels++;}},{highWaterMark:0});
 const pending=readRetainedPrompt(new Response(body),3,()=>owns),rejection=assert.rejects(pending,/PROMPT_READ_STALE/);
 await entered.promise;assert.equal(snapshot().promptBytes,12);
 owns=false;controller.enqueue(new Uint8Array([65,66,67]));await rejection;
 assert.equal(cancels,1);assert.equal(body.locked,false);assert.equal(snapshot().activeRecords,0);
});

for(const [name,bytes]of [['invalid',new Uint8Array([0xc3,0x28])],['incomplete',new Uint8Array([0xf0,0x9f,0x98])]])test(name+' UTF-8 prompt bytes reject without retaining decoded replacement text',async()=>{
 let sent=false;
 const body=new ReadableStream({pull(controller){if(sent)controller.close();else{sent=true;controller.enqueue(bytes);}}},{highWaterMark:0});
 await assert.rejects(readRetainedPrompt(new Response(body),bytes.length,()=>true),TypeError);
 assert.equal(snapshot().promptBytes,0);assert.equal(snapshot().activeRecords,0);assert.equal(body.locked,false);
});

test('a full prompt partition refuses payload admission before reading response bytes',async t=>{
 pressure(t,0);let pulls=0,readers=0;
 const body=new ReadableStream({pull(){pulls++;}},{highWaterMark:0}),response=new Response(body),getReader=body.getReader.bind(body);
 t.mock.method(body,'getReader',(...args)=>{readers++;return getReader(...args);});
 await assert.rejects(readRetainedPrompt(response,1,()=>true),/PROMPT_MEMORY_BUDGET/);
 assert.equal(readers,1,'Only terminal-aware cleanup acquires the reader after payload refusal');assert.equal(pulls,0);assert.equal(body.locked,false);
 assert.equal(snapshot().activeRecords,1,'Only the independent pressure lease remains');
 await body.cancel();
});

test('a response already locked by another owner retains explicit failed cleanup rather than a false refund',async()=>{
 const graph=await isolatedDiagnosticModules(),prompt=await import(await module('src/observability/prompt-memory.ts',{'./allocations.js':graph.allocationsURL})),{allocationLedger:ledger}=await import(graph.allocationsURL),before=ledger.snapshot();
 const body=new ReadableStream({},{highWaterMark:0}),response=new Response(body),reader=body.getReader();let failure;
 try{
  await assert.rejects(prompt.readRetainedPrompt(response,1,()=>true),error=>{failure=error;return error instanceof prompt.PromptReaderCleanupError;});
  assert.equal(failure.resource.response,response);assert.equal(failure.resource.reader,undefined);
  assert.equal(ledger.snapshot().promptBytes-before.promptBytes,4);assert.equal(ledger.snapshot().activeRecords-before.activeRecords,1);
  assert.equal(body.locked,true,'The foreign lock was never released by this owner');assert.deepEqual(prompt.promptReaderCleanupFailures(),[failure]);
  await assert.rejects(failure.retry());await assert.rejects(prompt.retryPromptReaderCleanups(),/PROMPT_READER_CLEANUP_INCOMPLETE/);
  assert.equal(ledger.snapshot().activeRecords-before.activeRecords,1,'Unknown cancellation success cannot refund the retained lease');
 }
 finally{reader.releaseLock();await body.cancel();}
 // This isolated real graph intentionally retains the failed ownership proof;
 // foreign cleanup is not a success receipt for the failed owner's cancel.
 assert.equal(ledger.snapshot().activeRecords-before.activeRecords,1);
});

test('an underlying cancellation rejection remains explicit and charged after unlocking',async()=>{
 const graph=await isolatedDiagnosticModules(),prompt=await import(await module('src/observability/prompt-memory.ts',{'./allocations.js':graph.allocationsURL})),{allocationLedger:ledger}=await import(graph.allocationsURL),before=ledger.snapshot();let cancels=0,failure;
 const body=new ReadableStream({cancel(){cancels++;throw Error('CANCEL_FAILED');}},{highWaterMark:0}),response=new Response(body);
 await assert.rejects(prompt.readRetainedPrompt(response,1,()=>false),error=>{failure=error;return error instanceof prompt.PromptReaderCleanupError&&error.errors.some(cause=>String(cause).includes('PROMPT_READ_STALE'))&&error.cancellationFailed;});
 assert.equal(cancels,1);assert.equal(body.locked,false);assert.equal(ledger.snapshot().activeRecords-before.activeRecords,1);
 assert.deepEqual(failure.errors.map(error=>error.message),['PROMPT_READ_STALE','CANCEL_FAILED']);
 assert.equal(failure.resource.response,response);assert.ok(failure.resource.retainedReader);assert.deepEqual(prompt.promptReaderCleanupFailures(),[failure]);
 for(let retry=0;retry<3;retry++){await assert.rejects(failure.retry(),error=>error===failure);assert.equal(ledger.snapshot().activeRecords-before.activeRecords,1);}
 await assert.rejects(prompt.retryPromptReaderCleanups(),/PROMPT_READER_CLEANUP_INCOMPLETE/);assert.equal(ledger.snapshot().activeRecords-before.activeRecords,1);
});

test('a first reader unlock failure rejects the transfer and retries cleanup before refunding its lease',async t=>{
 let unlocks=0;
 const fault=Error('FIRST_UNLOCK_FAILED'),body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('ok'));controller.close();}});
 const response=new Response(body),getReader=body.getReader.bind(body);
 t.mock.method(body,'getReader',(...args)=>{
  const reader=getReader(...args),releaseLock=reader.releaseLock.bind(reader);
  t.mock.method(reader,'releaseLock',()=>{if(++unlocks===1)throw fault;return releaseLock();});
  return reader;
 });
 await assert.rejects(readRetainedPrompt(response,2,()=>true),error=>error===fault);
 assert.equal(unlocks,2,'A failed transfer unlock is retried during cleanup');
 assert.equal(body.locked,false);assert.equal(snapshot().promptBytes,0);assert.equal(snapshot().activeRecords,0);
});

test('invalid expected prompt lengths cancel unread bodies through a cleanup-only reader',async t=>{
 for(const expectedBytes of [-1,0.5,NaN,Infinity,16*1024**2+1]){
  let cancels=0,pulls=0,readers=0,reads=0;
  const body=new ReadableStream({pull(){pulls++;},cancel(){cancels++;}},{highWaterMark:0}),response=new Response(body),getReader=body.getReader.bind(body);
  t.mock.method(body,'getReader',(...args)=>{readers++;const reader=getReader(...args),read=reader.read.bind(reader);t.mock.method(reader,'read',(...args)=>{reads++;return read(...args);});return reader;});
  await assert.rejects(readRetainedPrompt(response,expectedBytes,()=>true),/PROMPT_CONTENT_SIZE/);
  assert.equal(cancels,1,String(expectedBytes));assert.equal(pulls,0);assert.equal(readers,1);assert.equal(reads,0);
  assert.equal(body.locked,false);assert.equal(snapshot().activeRecords,0);
 }
});

test('aborting a prompt read cancels a body that never completes and releases its reader and lease',{timeout:5000},async()=>{
 const entered=deferred(),abort=new AbortController();let cancels=0,pulls=0;
 const body=new ReadableStream({pull(){pulls++;entered.resolve();},cancel(){cancels++;}},{highWaterMark:0});
 const pending=readRetainedPrompt(new Response(body),8,()=>true,abort.signal),rejection=assert.rejects(pending,/PROMPT_READ_STALE/);
 await entered.promise;
 assert.equal(snapshot().promptBytes,32);assert.equal(body.locked,true);
 abort.abort();await rejection;
 assert.equal(cancels,1);assert.equal(pulls,1,'The canceled read settles without any source bytes or close notification');
 assert.equal(body.locked,false);assert.equal(snapshot().promptBytes,0);assert.equal(snapshot().activeRecords,0);
});

test('a pre-aborted prompt read cancels its response without reading or pulling any body bytes',async t=>{
 const abort=new AbortController();abort.abort();let reads=0,pulls=0,cancels=0;
 const body=new ReadableStream({pull(){pulls++;},cancel(){cancels++;}},{highWaterMark:0}),response=new Response(body),getReader=body.getReader.bind(body);
 t.mock.method(body,'getReader',(...args)=>{
  const reader=getReader(...args),read=reader.read.bind(reader);
  t.mock.method(reader,'read',(...readArgs)=>{reads++;return read(...readArgs);});
  return reader;
 });
 await assert.rejects(readRetainedPrompt(response,8,()=>true,abort.signal),/PROMPT_READ_STALE/);
 assert.equal(cancels,1);assert.equal(reads,0);assert.equal(pulls,0);
 assert.equal(body.locked,false);assert.equal(snapshot().promptBytes,0);assert.equal(snapshot().activeRecords,0);
});

test('twenty thousand one-byte prompt chunks retain bounded handles and the admitted payload allowance',async t=>{
 const expectedBytes=20000;let sent=0,peakHandles=0,peakBytes=0;
 const body=new ReadableStream({pull(controller){
  const observed=snapshot();peakHandles=Math.max(peakHandles,observed.byKind.prompt.handles);peakBytes=Math.max(peakBytes,observed.promptBytes);
  if(sent===expectedBytes)controller.close();else{sent++;controller.enqueue(new Uint8Array([65]));}
 }},{highWaterMark:0});
 const retained=await readRetainedPrompt(new Response(body),expectedBytes,()=>true);t.after(()=>retained.lease.release());
 assert.equal(sent,expectedBytes);assert.equal(retained.text,'A'.repeat(expectedBytes));
 assert.equal(peakBytes,expectedBytes*4,'Every observed pull stays within the original payload admission');
 assert.ok(peakHandles>=2&&peakHandles<10,'Transport chunk count must not become the retained handle count: '+peakHandles);
 assert.equal(snapshot().promptBytes,expectedBytes*2);assert.equal(snapshot().byKind.prompt.handles,1);assert.equal(body.locked,false);
 retained.lease.release();assert.equal(snapshot().promptBytes,0);assert.equal(snapshot().activeRecords,0);
});

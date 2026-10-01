// Source-only staging: these tests are authored for the promoted tree and have
// not been executed. Optional roots make deliberate staging qualification clear.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
const root=process.env.ALLOCATION_CLOSURE_ROOT??'.',shared=process.env.ALLOCATION_SHARED_ROOT??'.';
const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
async function moduleURL(path,imports={}){let source=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))source=source.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(source);}
const allocationURL=await moduleURL('src/observability/allocations.ts');
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
  const before=allocationLedger.snapshot(),rows=[{id:'one',revision:'1'},{id:'two',revision:'2'}],owned=await collectOwnedDocuments(cache(rows));
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
const clientSource=(await transformWithOxc(await readFile(root+'/src/state/editor-client.ts','utf8'),'editor-client.ts')).code.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];?\n/gm,'');
const {EditorClient}=await import(data(`import {allocationLedger} from ${JSON.stringify(allocationURL)};import {readOwnedJSON} from ${JSON.stringify(memoryURL)};import {collectOwnedDocuments} from ${JSON.stringify(documentsURL)};import {DocumentResources} from ${JSON.stringify(resourceURL)};
const createValueModel=initial=>{let value=initial;return {value:{get:()=>value},set:next=>{value=next;}};};const browserPhases={reset(){}};\n`+clientSource));
test('EditorClient refusal preserves the exact previous complete list and current row ownership',async()=>{
  const before=allocationLedger.snapshot(),client=new EditorClient({transport:async()=>{throw Error('Unexpected transport');}});
  client.cache=cache([{id:'one',revision:'1'}]);await client.refresh();const original=client.view.documents,originalBytes=allocationLedger.snapshot().cpuBytes-before.cpuBytes;client.patch({document:original[0]});
  client.cache={published:async()=>({generation:'g',cursor:'2'}),async *rows(){for(let i=0;i<=DOCUMENT_LIST_LIMITS.documents;i++)yield {value:{id:String(i)}};},close(){}};
  await assert.rejects(client.refresh(),DocumentListAdmissionError);assert.equal(client.view.documents,original);assert.equal(client.view.document,original[0]);assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,originalBytes);
  // A current image probe can refuse a newer row. Its old active row must keep
  // the former list owner alive while the complete new list is displayed.
  client.cache=cache([{id:'one',revision:'2'}]);client.loadDocument=async()=>{};await client.refresh();const replacement=client.view.documents;
  assert.equal(client.view.document,original[0]);assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,modelPayloadBytes(original)+modelPayloadBytes(replacement));
  client.patch({document:replacement[0]});assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,modelPayloadBytes(replacement));client.dispose();await Promise.resolve();assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
});

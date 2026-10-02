import {allocationsURL,diagnosticMemoryURL,browserPhasesURL as browserURL} from '../owned-preview-module.mjs';
import {resolveAdapterUploadModules} from '../adapter-upload-module.mjs';
import {viewModelDependencies} from '../view-model-module.mjs';
import {draftStateDependencies} from '../draft-state-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transformWithOxc} from 'vite';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
// Exercise the real EditorClient upload/checkpoint methods and incremental hash.
// Unused recovery/browser dependencies are stand-ins; transport is recorded.
const source=(await transformWithOxc(await readFile('src/state/editor-client.ts','utf8'),'editor-client.ts')).code.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];?\n/gm,'');
const sha='import {SHA256} from '+JSON.stringify(data((await transformWithOxc(await readFile('src/protocol/sha256.ts','utf8'),'sha256.ts')).code))+';';
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL);
const allocations='import {allocationLedger} from '+JSON.stringify(allocationsURL)+';';
const resourcesURL=data((await transformWithOxc(await readFile('src/state/document-lifecycle.ts','utf8'),'document-lifecycle.ts')).code);
const {draftURL,commandsURL,memoryURL,controlURL,promptURL}=await draftStateDependencies(allocationsURL);
const {adapterUploadURL}=await resolveAdapterUploadModules({allocationsURL,diagnosticMemoryURL,promptMemoryURL:promptURL,modelMemoryURL:memoryURL});
const {AdapterUploadObservations}=await import(adapterUploadURL);
const {viewURL}=await viewModelDependencies(allocationsURL,{memoryURL,controlURL,promptURL});
const {DraftPersistence}=await import(draftURL);
const {cloneOwnedModel}=await import(memoryURL);
const viewImports=`import {CommandControlReads} from ${JSON.stringify(commandsURL)};import {ViewModelOwners,ViewModelReads,canonicalControlHash,VIEW_MODEL_LIMITS,ownDownload} from ${JSON.stringify(viewURL)};import {readOwnedJSON,createOwnedModel,modelPayloadBytes} from ${JSON.stringify(memoryURL)};import {reserveCommandWire} from ${JSON.stringify(controlURL)};`;
const lifecycle='import {DocumentResources} from '+JSON.stringify(resourcesURL)+';import {browserPhases} from '+JSON.stringify(browserURL)+';';
const stub='const createValueModel=initial=>{let v=initial;return {value:{get:()=>v},set:next=>v=next};};';
const {EditorClient}=await import(data(stub+sha+allocations+lifecycle+viewImports+source));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
const fixtures=new Set();
test.afterEach(async()=>{for(const fixture of fixtures){await fixture.close();fixtures.delete(fixture);}});
function fixture(size=1048577){
 const baseline=allocationLedger.snapshot(),owners=new Set();
 const bytes=new Uint8Array(size).fill(19),requests=[],slices=[];let identity='first',hook=async()=>{};const transport=async(path,init={})=>{const method=init.method??'GET';requests.push({path,method,init,identity});await hook(method);const offset=method==='PUT'?String(Number(init.headers['Upload-Offset'])+init.body.byteLength):'0';return {ok:true,async json(){await hook(method+' JSON');return {committedOffset:offset};}};};
 const session={identity:()=>identity,transport,csrf:()=> 'csrf'},client=new EditorClient(session);
 const newOwner=()=>{const owner=new DraftPersistence('session',session.transport,session.csrf);owner.checkpoint={sessionId:'session',uiSeq:'0',preferences:{documentId:null,tool:'select',viewport:{x:0,y:0,zoom:1},panels:{left:280,right:320,active:'layers'},selectedLayerIds:[]},drafts:[],reconciledLayerIds:[]};owners.add(owner);return owner;};
 client.draftOwner=newOwner();client.ui=client.draftOwner.checkpoint;
 let beforeSlice=async()=>{};const file={size,slice(start,end){slices.push([start,end]);return {async arrayBuffer(){await beforeSlice(slices.length,start,end);return bytes.slice(start,end).buffer;}};}};
 let closing;const result={client,bytes,file,requests,slices,identity(value){identity=value;},hook(value){hook=value;},sliceHook(value){beforeSlice=value;},replaceDraftOwner(){client.draftOwner=newOwner();},close(){return closing??=(async()=>{client.dispose();await client.documentResources.release();await Promise.all([...owners].map(owner=>owner.dispose()));await client.recoveryDrain;await client.drainDraftOwners();assert.equal(client.view,client.viewModels.terminalView());const after=allocationLedger.snapshot();assert.equal(after.cpuBytes,baseline.cpuBytes);assert.equal(after.handles,baseline.handles);assert.equal(after.activeRecords,baseline.activeRecords);})();}};fixtures.add(result);return result;
}
test('successful upload preserves exact hash, bounded hash reads and 1MiB transfer parts',async()=>{const f=fixture(),r=await f.client.upload(f.file,'adapter','application/octet-stream');assert.equal(r.sha256,'sha256:'+createHash('sha256').update(f.bytes).digest('hex'));assert.deepEqual(f.requests.map(r=>r.method),['POST','GET','PUT','PUT']);assert.deepEqual(f.requests.filter(r=>r.method==='PUT').map(r=>r.init.body.byteLength),[1048576,1]);assert(f.slices.slice(0,-2).every(([start,end])=>end-start>0&&end-start<=65536));assert(f.requests.every(r=>r.identity==='first'));});
for(const boundary of ['identity','session','ui-session','draft-owner','disconnect','predicate'])test('hash completion after '+boundary+' cannot create a staging transfer',async()=>{
 const f=fixture(4),entered=deferred(),release=deferred();let current=true;f.sliceHook(async()=>{entered.resolve();await release.promise;});const pending=f.client.upload(f.file,'adapter','application/octet-stream',undefined,()=>current);await entered.promise;
 if(boundary==='identity')f.identity('second');if(boundary==='session')f.client.session={...f.client.session};if(boundary==='ui-session')f.client.ui={...f.client.ui,sessionId:'other'};if(boundary==='draft-owner')f.replaceDraftOwner();if(boundary==='disconnect')f.client.disconnect();if(boundary==='predicate')current=false;release.resolve();await assert.rejects(pending,/UPLOAD_OWNER_CHANGED/);assert.equal(f.requests.length,0);
});
for(const phase of ['POST','POST JSON','GET','GET JSON','PUT','PUT JSON'])test('owner change during '+phase+' stops every subsequent transfer request',async()=>{
 const f=fixture(),entered=deferred(),release=deferred();let blocked=false;f.hook(async method=>{if(method===phase&&!blocked){blocked=true;entered.resolve();await release.promise;}});const pending=f.client.upload(f.file,'adapter','application/octet-stream');await entered.promise;const before=f.requests.length;f.identity('second');release.resolve();await assert.rejects(pending,/UPLOAD_OWNER_CHANGED/);assert.equal(f.requests.length,before);assert(f.requests.every(r=>r.identity==='first'));assert(f.requests.at(-1).init.signal.aborted);
});
test('owner change while reading a transfer part cannot send that part',async()=>{const f=fixture(4),entered=deferred(),release=deferred();f.sliceHook(async n=>{if(n===2){entered.resolve();await release.promise;}});const pending=f.client.upload(f.file,'adapter','application/octet-stream');await entered.promise;f.identity('second');release.resolve();await assert.rejects(pending,/UPLOAD_OWNER_CHANGED/);assert.deepEqual(f.requests.map(r=>r.method),['POST','GET']);});
test('an already stale caller cannot even read the local file',async()=>{const f=fixture();await assert.rejects(f.client.upload(f.file,'adapter','application/octet-stream',undefined,()=>false),/UPLOAD_OWNER_CHANGED/);assert.equal(f.slices.length,0);assert.equal(f.requests.length,0);});
function checkpointFixture(hasImage){
 const f=fixture(1),documents=cloneOwnedModel('checkpoint-fixture-documents',[{id:'doc',revision:'1'}]),doc=documents.value[0],page=cloneOwnedModel('checkpoint-fixture-page',{items:[{documentId:'doc',historyHead:'root'}],next:null}),checkpoint=page.value.items[0];
 f.client.documentsMetadata={documents:documents.value,pin:()=>documents.pin(),release:()=>documents.release()};f.client.patch({document:doc,documents:documents.value});f.client.publishViewModels([f.client.viewInput('checkpoints',page,'fixture',page.value.items)],{checkpoints:page.value.items});
 f.client.session.transport=async()=>{const text=JSON.stringify({items:[{id:'root',documentId:'doc',branchId:'branch',parent:null,forward:{before:null,after:hasImage?{...doc,image:{state:{hash:'retained'}}}:doc},inverse:{},roots:[]}],next:null});return new Response(text,{headers:{'content-length':String(new TextEncoder().encode(text).byteLength)}});};
 return {...f,doc,checkpoint,async close(){await f.client.viewReads.release();f.client.patch({document:null,documents:[],checkpoints:[]});documents.release();f.client.documentsMetadata=undefined;await f.close();}};
}
test('an image-bearing document root checkpoint switches to the exact retained branch',async()=>{const f=checkpointFixture(true),commands=[];try{f.client.ownedCommand=async(body,document)=>{commands.push({body,document});return cloneOwnedModel('checkpoint-command-events',[]);};await f.client.openCheckpoint(f.checkpoint);assert.deepEqual(commands,[{body:{type:'SwitchBranch',branchId:'branch',historyNode:'root'},document:f.doc}]);}finally{await f.close();}});
test('an empty document root still explains that no image can be restored',async()=>{const f=checkpointFixture(false);try{f.client.ownedCommand=async()=>assert.fail('empty root must not navigate');await assert.rejects(f.client.openCheckpoint(f.checkpoint),/empty-document checkpoint/);}finally{await f.close();}});

test('hash buffer admission precedes the native read and remains charged until it settles',async()=>{
 const f=fixture(4),before=allocationLedger.snapshot(),entered=deferred(),release=deferred();
 f.sliceHook(async()=>{assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,4);entered.resolve();await release.promise;});
 const work=f.client.upload(f.file,'adapter','application/octet-stream');await entered.promise;
 f.identity('changed');assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,4);release.resolve();
 await assert.rejects(work,/UPLOAD_OWNER_CHANGED/);assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords);
});

test('upload PUT retains both owned body allowances until the transport response drains',async()=>{
 const f=fixture(4),before=allocationLedger.snapshot(),entered=deferred(),release=deferred();
 f.hook(async method=>{if(method==='PUT JSON'){entered.resolve();await release.promise;}});
 const work=f.client.upload(f.file,'adapter','application/octet-stream');await entered.promise;
 assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,8);assert.equal(allocationLedger.snapshot().byKind.staging.handles-before.byKind.staging.handles,2);
 release.resolve();await work;assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords);
});

test('hash admission refuses before any native file read or transfer',async()=>{
 const f=fixture(4),before=allocationLedger.snapshot(),pressure=allocationLedger.reserve({owner:'test-upload-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-before.cpuBytes-3});
 try{await assert.rejects(f.client.upload(f.file,'adapter','application/octet-stream'),/ALLOCATION_BUDGET/);assert.deepEqual(f.slices,[]);assert.deepEqual(f.requests,[]);}
 finally{pressure.release();}
 assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords);
});

test('PUT admission refuses before creating the transfer body after hashing succeeds',async()=>{
 const f=fixture(4),before=allocationLedger.snapshot();let pressure;
 f.hook(async method=>{if(method==='GET JSON')pressure=allocationLedger.reserve({owner:'test-upload-put-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-before.cpuBytes-7});});
 try{await assert.rejects(f.client.upload(f.file,'adapter','application/octet-stream'),/ALLOCATION_BUDGET/);assert.equal(f.slices.length,1);assert.deepEqual(f.requests.map(request=>request.method),['POST','GET']);}
 finally{pressure?.release();}
 assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords);
});

test('external batch stop before upload reads no bytes and creates no staging',async()=>{
 const f=fixture(4),abort=new AbortController();abort.abort();await assert.rejects(f.client.upload(f.file,'image','image/png',undefined,()=>true,abort.signal),/UPLOAD_OWNER_CHANGED/);assert.equal(f.slices.length,0);assert.equal(f.requests.length,0);assert.equal(f.client.uploads.size,0);
});
test('external batch stop preserves in-flight native read ownership until its exact settlement',async()=>{
 const f=fixture(4),before=allocationLedger.snapshot(),abort=new AbortController(),entered=deferred(),gate=deferred();f.sliceHook(async()=>{entered.resolve();await gate.promise;});let ended=false;
 const work=f.client.upload(f.file,'image','image/png',undefined,()=>true,abort.signal).finally(()=>{ended=true;});await entered.promise;abort.abort();await Promise.resolve();assert.equal(ended,false);assert.equal(f.client.uploads.size,1);assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,4);gate.resolve();await assert.rejects(work,/UPLOAD_OWNER_CHANGED/);assert.equal(f.requests.length,0);assert.equal(f.client.uploads.size,0);assert.equal(f.client.uploadSettlements.size,0);assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
});
test('external batch stop aborts the active transport without refunding its pending body',async()=>{
 const f=fixture(4),before=allocationLedger.snapshot(),abort=new AbortController(),entered=deferred(),gate=deferred();f.hook(async method=>{if(method==='PUT'){entered.resolve();await gate.promise;}});const work=f.client.upload(f.file,'image','image/png',undefined,()=>true,abort.signal);await entered.promise;abort.abort();assert.equal(f.requests.at(-1).init.signal.aborted,true);assert.equal(allocationLedger.snapshot().cpuBytes-before.cpuBytes,8);gate.resolve();await assert.rejects(work,/UPLOAD_OWNER_CHANGED/);assert.deepEqual(f.requests.map(request=>request.method),['POST','GET','PUT']);assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);
});

// The diagnostic branch uses the same real client/control/model owners as the
// legacy cases. Only this File instance's native read settlement is gated; no
// global Blob patch or caller-supplied observation counters are used.
const sha256=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const uploadSnapshot=observed=>{const value=observed.readSnapshot();try{return structuredClone(value.value);}finally{value.release();}};
function observedFile(f,beforeRead=async()=>{}){
 const file=new File([f.bytes],'owned-weights.safetensors',{type:'application/octet-stream'}),slice=file.slice.bind(file);
 Object.defineProperty(file,'slice',{value:(start,end)=>{
  f.slices.push([start,end]);const part=slice(start,end),read=part.arrayBuffer.bind(part);
  Object.defineProperty(part,'arrayBuffer',{value:async()=>{const bytes=await read();await beforeRead({start,end,bytes});return bytes;}});return part;
 }});return file;
}
function exactStagingTransport(f,beforeResponse=async()=>{}){
 const records=new Map(),bodies=[];
 f.client.session.transport=async(path,init={})=>{
  const method=init.method??'GET',identity=f.client.session.identity();f.requests.push({path,method,init,identity});
  let value;
  if(method==='POST'){
   assert.equal(path,'/api/v1/assets/staging');value=JSON.parse(init.body);assert.equal(value.protocolVersion,1);assert.equal(records.has(value.stagingId),false);
   value={...value,ownerClientId:identity,version:'1',committedOffset:'0',state:'receiving'};records.set(value.stagingId,value);
  }else{
   const match=/^\/api\/v1\/assets\/staging\/([A-Za-z0-9_-]+)$/.exec(path);assert.ok(match);value=records.get(match[1]);assert.ok(value);
   if(method==='PUT'){
    assert.equal(init.headers['Upload-Offset'],value.committedOffset);assert.ok(init.body instanceof ArrayBuffer);assert.ok(init.body.byteLength>0&&init.body.byteLength<=1048576);
    const bytes=Buffer.from(new Uint8Array(init.body));bodies.push(bytes);const next=Number(value.committedOffset)+bytes.length;assert.ok(next<=Number(value.expectedBytes));
    value.committedOffset=String(next);value.version=String(Number(value.version)+1);value.state=value.committedOffset===value.expectedBytes?'complete':'receiving';
   }else assert.equal(method,'GET');
  }
  await beforeResponse({method,path,init,value});
  const bytes=Buffer.from(JSON.stringify(value));return new Response(bytes,{status:method==='POST'?201:200,headers:{'content-type':'application/json','content-length':String(bytes.length)}});
 };
 return {records,bodies};
}
function assertUploadOwners(client,pending){
 assert.deepEqual(client.controlReads.ownership,{controlReads:pending,controlCleanupFailures:0});assert.equal(client.uploads.size,pending);assert.equal(client.uploadSettlements.size,pending);
}
function assertLiveAllocations(before){const after=allocationLedger.snapshot();for(const key of ['cpuBytes','handles','activeRecords'])assert.equal(after[key],before[key],key+' must return to the admitted baseline');}
async function enteredBeforeSettlement(entered,work){await Promise.race([entered.promise,work.then(()=>{throw Error('Owned upload settled before the held boundary');})]);}

test('ownedUpload diagnostic branch preserves actual producer bytes and drains outer owners only after PUT settlement',{timeout:15000},async()=>{
 const f=fixture(),observed=new AdapterUploadObservations(4),entered=deferred(),gate=deferred(),file=observedFile(f);let held=false;
 const transport=exactStagingTransport(f,async({method})=>{if(method==='PUT'&&!held){held=true;entered.resolve();await gate.promise;}}),before=allocationLedger.snapshot();
 const work=f.client.ownedUpload(file,'adapter','application/octet-stream',undefined,()=>true,undefined,observed.bind(file,'adapter-weights'));void work.catch(()=>{});
 try{
  await enteredBeforeSettlement(entered,work);assertUploadOwners(f.client,1);let settled=false;const settlement=[...f.client.uploadSettlements.values()][0];void settlement.then(()=>{settled=true;});await Promise.resolve();assert.equal(settled,false);
  const active=uploadSnapshot(observed);assert.equal(active.active,1);assert.equal(active.operations[0].outcome,'active');assert.equal(active.operations[0].transfer.acks,0);assert.equal(active.operations[0].hash.sha256,sha256(f.bytes));
  gate.resolve();const request=await work;
  try{
   await settlement;assert.equal(settled,true);assertUploadOwners(f.client,0);const value=uploadSnapshot(observed),row=value.operations[0];
   assert.equal(value.active,0);assert.equal(row.outcome,'complete');assert.equal(row.settled,true);assert.equal(row.liveReads,0);assert.deepEqual(row.missing,[]);
   assert.equal(request.value.sha256,sha256(f.bytes));assert.equal(row.hash.sha256,request.value.sha256);assert.equal(row.stagingId,request.value.stagingId);assert.equal(row.bytes,f.bytes.length);
   assert.equal(row.owner.sessionHash,sha256(f.client.sessionId));assert.equal(row.owner.draftSessionHash,sha256(f.client.draftOwner.sessionId));assert.equal(row.owner.clientHash,sha256('first'));assert.equal(row.owner.documentHash,null);
   assert.equal(row.hash.chunks,17);assert.equal(row.transfer.chunks,2);assert.equal(row.transfer.acks,2);assert.equal(row.transfer.lastCommittedOffset,String(f.bytes.length));assert.equal(row.transfer.lastState,'complete');
   assert.deepEqual(Buffer.concat(transport.bodies),Buffer.from(f.bytes));assert.deepEqual(f.requests.map(value=>value.method),['POST','GET','PUT','PUT']);assert.deepEqual(transport.bodies.map(value=>value.length),[1048576,1]);
   assert.ok(f.slices.slice(0,-2).every(([start,end])=>end-start>0&&end-start<=65536));assert.equal(transport.records.get(row.stagingId).sha256,row.hash.sha256);
  }finally{request.release();}
  assertLiveAllocations(before);
 }finally{gate.resolve();await work.then(value=>value.release(),()=>{});observed.dispose();await f.close();}
});

for(const boundary of ['identity','session'])test('ownedUpload diagnostic branch retains a native hash read across '+boundary+' change and starts no transfer',{timeout:15000},async()=>{
 const f=fixture(4),observed=new AdapterUploadObservations(4),entered=deferred(),gate=deferred(),file=observedFile(f,async({bytes})=>{assert.deepEqual(new Uint8Array(bytes),f.bytes);entered.resolve();await gate.promise;});
 exactStagingTransport(f);const before=allocationLedger.snapshot(),work=f.client.ownedUpload(file,'adapter','application/octet-stream',undefined,()=>true,undefined,observed.bind(file,'adapter-weights'));void work.catch(()=>{});
 try{
  await enteredBeforeSettlement(entered,work);assertUploadOwners(f.client,1);const settlement=[...f.client.uploadSettlements.values()][0];let settled=false;void settlement.then(()=>{settled=true;});
  if(boundary==='identity')f.identity('second');else f.client.session={...f.client.session};await Promise.resolve();assert.equal(settled,false);assertUploadOwners(f.client,1);
  const active=uploadSnapshot(observed);assert.equal(active.active,1);assert.equal(active.operations[0].liveReads,1);assert.equal(active.operations[0].settled,false);assert.equal(active.operations[0].hash.sha256,null);
  assert.equal(allocationLedger.snapshot().byKind.staging.cpuBytes-before.byKind.staging.cpuBytes,4);assert.deepEqual(f.requests,[]);
  gate.resolve();await assert.rejects(work,/UPLOAD_OWNER_CHANGED/);await settlement;assert.equal(settled,true);assertUploadOwners(f.client,0);assert.deepEqual(f.requests,[]);assert.deepEqual(f.slices,[[0,4]]);
  const row=uploadSnapshot(observed).operations[0];assert.equal(row.outcome,'error');assert.equal(row.settled,true);assert.equal(row.liveReads,0);assert.equal(row.hash.sha256,null);assert.equal(row.transfer.chunks,0);assert.ok(row.missing.includes('aborted'));assertLiveAllocations(before);
 }finally{gate.resolve();await work.then(value=>value.release(),()=>{});observed.dispose();await f.close();}
});

test('ownedUpload diagnostic branch forwards external abort and retains the pending PUT body until exact settlement',{timeout:15000},async()=>{
 const f=fixture(),observed=new AdapterUploadObservations(4),entered=deferred(),gate=deferred(),abort=new AbortController(),file=observedFile(f);
 exactStagingTransport(f,async({method})=>{if(method==='PUT'){entered.resolve();await gate.promise;}});const before=allocationLedger.snapshot();
 const work=f.client.ownedUpload(file,'adapter','application/octet-stream',undefined,()=>true,abort.signal,observed.bind(file,'adapter-weights'));void work.catch(()=>{});
 try{
  await enteredBeforeSettlement(entered,work);const settlement=[...f.client.uploadSettlements.values()][0];let settled=false;void settlement.then(()=>{settled=true;});assertUploadOwners(f.client,1);
  abort.abort();await Promise.resolve();assert.equal(f.requests.at(-1).init.signal.aborted,true);assert.equal(settled,false);assertUploadOwners(f.client,1);
  const active=uploadSnapshot(observed);assert.equal(active.active,1);assert.equal(active.operations[0].settled,false);assert.equal(active.operations[0].transfer.acks,0);
  assert.equal(allocationLedger.snapshot().byKind.staging.cpuBytes-before.byKind.staging.cpuBytes,2*1048576);
  gate.resolve();await assert.rejects(work,/PROMPT_READ_STALE/);await settlement;assert.equal(settled,true);assertUploadOwners(f.client,0);
  assert.deepEqual(f.requests.map(value=>value.method),['POST','GET','PUT']);const row=uploadSnapshot(observed).operations[0];assert.equal(row.outcome,'error');assert.equal(row.settled,true);assert.equal(row.liveReads,0);assert.ok(row.missing.includes('aborted'));assert.equal(row.transfer.acks,0);assert.equal(row.transfer.lastCommittedOffset,'0');assertLiveAllocations(before);
 }finally{gate.resolve();await work.then(value=>value.release(),()=>{});observed.dispose();await f.close();}
});

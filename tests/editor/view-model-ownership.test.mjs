// Authored against promoted paths; not executed during source staging.
import {draftStateDependencies} from '../draft-state-module.mjs';
import {allocationsURL as allocations,navigationObservationsURL} from '../owned-preview-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc} from 'vite';
const root=process.env.CLIENT_ALLOCATION_ROOT??'.';
const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
async function moduleURL(path,imports={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const prompt=await moduleURL('src/observability/prompt-memory.ts',{'./allocations.js':allocations}),memory=await moduleURL('src/observability/model-memory.ts',{'./allocations.js':allocations,'./prompt-memory.js':prompt}),control=await moduleURL('src/state/control-memory.ts',{'../observability/allocations.js':allocations}),json=await moduleURL('src/protocol/json.ts'),sha=await moduleURL('src/protocol/sha256.ts');
const owners=await moduleURL(root+'/src/state/view-models.ts',{'../observability/allocations.js':allocations,'../observability/model-memory.js':memory,'../observability/prompt-memory.js':prompt,'./control-memory.js':control,'../protocol/json.js':json,'../protocol/sha256.js':sha});
const inspectorTransformURL=await moduleURL(root+'/src/ui/inspector-transform.ts');
const inspector=await moduleURL(root+'/src/ui/inspector-model.ts',{'./inspector-transform.js':inspectorTransformURL,'../observability/allocations.js':allocations,'../observability/model-memory.js':memory,'../observability/prompt-memory.js':prompt});
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocations),{cloneOwnedModel,createOwnedModel,modelPayloadBytes,readOwnedJSON}=await import(memory),{PromptReaderCleanupError}=await import(prompt),{ViewModelOwners,ViewModelReads,canonicalControlHash}=await import(owners),{newInspector,ownInspector,restoredInspector,INSPECTOR_MODEL_BYTES}=await import(inspector);
const snapshot=()=>allocationLedger.snapshot(),flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const response=value=>{const wire=JSON.stringify(value);return new Response(wire,{headers:{'content-length':String(new TextEncoder().encode(wire).length)}});};
const input=(model,identity='one')=>({slot:'image',model,identity,exposed:model.value,references:function*(){yield model.value;for(const layer of model.value.layers)yield layer;}});
const image=id=>({schemaVersion:1,width:1,height:1,layers:[{id,name:id}]});
test('replaced roots release synchronously except for explicit action pins',()=>{
 const before=snapshot(),owner=new ViewModelOwners(),first=cloneOwnedModel('view-test',image('one'));owner.publish([input(first)],()=>{});const layer=first.value.layers[0],unpin=owner.borrow(layer),second=cloneOwnedModel('view-test',image('two'));owner.publish([input(second,'two')],()=>{});
 assert.equal(owner.ownership.retiredPinnedRoots,1);assert.equal(owner.ownership.activePins,1);assert(snapshot().cpuBytes>modelPayloadBytes(second.value));unpin();assert.equal(owner.ownership.retiredPinnedRoots,0);assert.throws(()=>owner.borrow(layer),/VIEW_MODEL_UNOWNED/);owner.clearReplaced({image:null});assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('publication refusal keeps prior ownership and current identity',()=>{
 const before=snapshot(),owner=new ViewModelOwners(),first=cloneOwnedModel('view-test',image('one'));owner.publish([input(first)],()=>{});const next=cloneOwnedModel('view-test',image('two'));assert.throws(()=>owner.publish([input(next,'two')],()=>{throw Error('publish refused');}),/publish refused/);next.release();assert(owner.isCurrent('image',first.value));const borrowed=owner.reuse('image','one');assert.equal(borrowed.value,first.value);borrowed.release();owner.clearReplaced({image:null});assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('multiple borrowed identities deduplicate the actual owner and unknown values roll back pins',()=>{
 const before=snapshot(),owner=new ViewModelOwners(),model=cloneOwnedModel('view-test',image('one'));owner.publish([input(model)],()=>{});const release=owner.borrowMany([model.value,model.value.layers[0],model.value]);assert.equal(owner.ownership.activePins,1);assert.throws(()=>owner.borrowMany([model.value,{}]),/VIEW_MODEL_UNOWNED/);assert.equal(owner.ownership.activePins,1);owner.clearReplaced({image:null});release();release();assert.equal(owner.ownership.retiredPinnedRoots,0);assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('view read drain waits for actual native cancellation completion',async()=>{
 const before=snapshot(),cancel=deferred(),scope=new ViewModelReads();let entered=false,drained=false;
 const stream=new ReadableStream({cancel(){entered=true;return cancel.promise;}}),work=scope.run(signal=>readOwnedJSON(async()=>new Response(stream,{headers:{'content-length':'4'}}),'/view',{owner:'view-test',init:{signal},maxBytes:64})).catch(error=>error);
 await flush();const draining=scope.release().then(()=>{drained=true;});await flush();assert.equal(entered,true);assert.equal(drained,false);assert(snapshot().cpuBytes>before.cpuBytes);cancel.resolve();await draining;await work;assert.equal(scope.ownership.activeReads,0);assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('unlock cleanup failures retain their real lease and retry through view drain',async()=>{
 const before=snapshot(),scope=new ViewModelReads(),lease=allocationLedger.reserve({owner:'view-test',kind:'control',cpuBytes:10});let fail=true;
 const failure=new PromptReaderCleanupError([Error('unlock')],{response:{},reader:{releaseLock(){if(fail)throw Error('unlock');}},lease},false);
 await assert.rejects(scope.run(async()=>{throw failure;}));await assert.rejects(scope.release(),/VIEW_MODEL_READ_CLEANUP_FAILED/);assert.equal(scope.ownership.cleanupFailures,1);assert.equal(snapshot().cpuBytes,before.cpuBytes+10);fail=false;await scope.release();assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('view drain rejects concurrent admissions and allows reads after completion',async()=>{
 const before=snapshot(),gate=deferred(),scope=new ViewModelReads();let entered=false;const work=scope.run(async()=>{entered=true;await gate.promise;});await flush();assert(entered);const drain=scope.release();await assert.rejects(scope.run(async()=>{}),{name:'AbortError'});assert.equal(scope.ownership.activeReads,1);gate.resolve();await Promise.all([work,drain]);await scope.run(async()=>{});assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('canonical hash workspace refuses before serialization when admission is unavailable',()=>{
 const before=snapshot(),blocker=allocationLedger.reserve({owner:'view-test-blocker',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-before.cpuBytes});try{assert.throws(()=>canonicalControlHash(image('a')),/ALLOCATION_BUDGET/);}finally{blocker.release();}assert.match(canonicalControlHash(image('a')),/^sha256:/);assert.equal(snapshot().cpuBytes,before.cpuBytes);
});

const resources=await moduleURL('src/state/document-lifecycle.ts');
const storeURL=await moduleURL('src/protocol/store.ts');
const historyAvailability=await moduleURL('src/state/history-availability.ts',{'../observability/model-memory.js':memory});
const {commandsURL,draftURL}=await draftStateDependencies(allocations,{memoryURL:memory,promptURL:prompt,controlURL:control});
const documentsURL=await moduleURL(root+'/src/state/document-list.ts',{'../observability/model-memory.js':memory});
const {DraftPersistence}=await import(draftURL);
const sessionURL=await moduleURL('src/state/session-client.ts',{'@en-reve/primitives/state/value.js':import.meta.resolve('@en-reve/primitives/state/value.js'),'../observability/model-memory.js':memory,'./control-memory.js':control,'./command-results.js':commandsURL});
const {createSessionClient}=await import(sessionURL),{readCommandEvents}=await import(commandsURL);
const clientCode=(await transformWithOxc(await readFile(root+'/src/state/editor-client.ts','utf8'),'editor-client.ts')).code.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];?\n/gm,'');
const {EditorClient,navigation,clientBoundaries}=await import(data(`import {NavigationObservations} from ${JSON.stringify(navigationObservationsURL)};export const navigation=new NavigationObservations(()=>performance.now(),performance.timeOrigin);import {allocationLedger} from ${JSON.stringify(allocations)};import {readOwnedJSON,createOwnedModel,cloneOwnedModel,modelPayloadBytes,ModelPayload} from ${JSON.stringify(memory)};import {reserveCommandWire,measureControl} from ${JSON.stringify(control)};import {DraftPersistence} from ${JSON.stringify(draftURL)};import {collectOwnedDocuments} from ${JSON.stringify(documentsURL)};import {ViewModelOwners,ViewModelReads,VIEW_MODEL_LIMITS,canonicalControlHash,ownDownload} from ${JSON.stringify(owners)};import {CommandControlReads,COMMAND_RESULT_LIMITS,readCommandEvents} from ${JSON.stringify(commandsURL)};import {EMPTY_EXPECTED_VERSIONS} from ${JSON.stringify(storeURL)};import {readUndoAvailability} from ${JSON.stringify(historyAvailability)};import {DocumentResources} from ${JSON.stringify(resources)};const createValueModel=initial=>{let value=initial;return {value:{get:()=>value},set:next=>{value=next;}};};export const clientBoundaries={cacheOpen(){throw Error('Unexpected cache open');},journalOpen(){throw Error('Unexpected journal open');},consumer(){throw Error('Unexpected recovery consumer');},storage:new Map()};const sessionStorage={getItem:key=>clientBoundaries.storage.get(key)??null,setItem:(key,value)=>clientBoundaries.storage.set(key,value)};class RecoveryCache{static open(...args){return clientBoundaries.cacheOpen(...args);}}class BrowserJournal{static open(...args){return clientBoundaries.journalOpen(...args);}}class RecoveryConsumer{constructor(...args){return clientBoundaries.consumer(...args);}}class RecoveryPublicationConflict extends Error{};const browserPhases={recorder:{start(){return {end(){}};}},reset(){navigation.reset();},resetNavigation(){navigation.reset();},recordNavigationModelReady:value=>navigation.modelReady(value),recordNavigationRenderSubmitted:value=>navigation.renderSubmitted(value),recordNavigationControlsRendered:(...args)=>navigation.controlsRendered(...args),recordNavigationControlsCommitted:(...args)=>navigation.controlsCommitted(...args),recordNavigationViewportUnavailable:()=>navigation.viewportUnavailable()};\n`+clientCode));
function fixture(withImage=false){
 const document={id:'d',revision:'1',orderedLayerIds:['a']},calls=[],state={image:image('a'),history:{items:[{id:'h'}],next:null},checkpoints:{items:[{id:'c',documentId:'d',historyHead:'h'}],next:null},save:{pendingCommandCount:0,draftDirty:false,documentChangedSinceCheckpoint:false,bundleOutdated:false},head:null,headVersion:'1',publishedGeneration:'g',badHistory:false};
 if(withImage)document.image={state:{hash:canonicalControlHash(state.image),byteLength:'1',mediaType:'application/json'},compositeAssetId:'canonical-asset'};
 const client=new EditorClient({identity:()=> 'view-model-fixture',transport:async(path,init)=>{calls.push(path);if(init?.method==='HEAD'){if(state.head)await state.head.promise;return new Response(null,{headers:{'X-App-Entity-Version':state.headVersion}});}if(path.endsWith('/history'))return state.badHistory?new Response('{}',{headers:{'content-length':'65537'}}):response(state.history);if(path.endsWith('/checkpoints'))return response(state.checkpoints);if(path.includes('/save-status'))return response(state.save);if(path.endsWith('/image'))return response(state.image);throw Error('Unexpected '+path);}}),documents=cloneOwnedModel('view-test-documents',[document]);
 client.documentsMetadata={documents:documents.value,pin:()=>documents.pin(),release:()=>documents.release()};client.cache={published:async()=>({generation:state.publishedGeneration,cursor:'1'}),read:async()=>documents.value[0],close(){}};client.patch({document:documents.value[0],documents:documents.value,ready:true});
 return {client,document:documents.value[0],state,calls,async close(){await client.dispose();}};
}
test('unchanged authority reuses actual view roots without accumulating retired payloads',async()=>{
 const before=snapshot(),f=fixture();await f.client.loadDocument(f.document);const prior=f.client.view.image,held=snapshot().cpuBytes;await f.client.loadDocument(f.document);assert.equal(f.client.view.image,prior);assert.equal(f.calls.filter(path=>path.endsWith('/image')).length,1);assert.equal(snapshot().cpuBytes,held);assert.equal(f.client.viewModels.ownership.retiredPinnedRoots,0);await f.close();assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('reused old page cannot be republished unowned after concurrent paging',async()=>{
 const before=snapshot(),f=fixture();await f.client.loadDocument(f.document);f.state.head=deferred();const started=f.calls.length,work=f.client.loadDocument(f.document);await flush();assert(f.calls.length>started);
 const next=cloneOwnedModel('view-test-page',{items:[{id:'new-page'}],next:null});f.client.publishViewModels([f.client.viewInput('history',next,'new-page',next.value.items)],{history:next.value.items});f.state.head.resolve();await work;assert.equal(f.client.view.history,next.value.items);assert.equal(f.client.viewModels.ownership.currentRoots,5);await f.close();assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('one refused response drains sibling owners and preserves the previous complete view',async()=>{
 const before=snapshot(),f=fixture();await f.client.loadDocument(f.document);const prior=f.client.view,held=snapshot().cpuBytes;f.client.lifecycle++;f.state.badHistory=true;await assert.rejects(f.client.loadDocument(f.document),/DOCUMENT_MODEL_READ_FAILED/);assert.equal(f.client.view,prior);assert.equal(snapshot().cpuBytes,held);await f.close();assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('authority change cannot reuse a former history/checkpoint root with coincident IDs',async()=>{
 const before=snapshot(),f=fixture();await f.client.loadDocument(f.document);const prior=f.client.view.history;f.client.lifecycle++;f.state.history={items:[{id:'new-authority'}],next:null};await f.client.loadDocument(f.document);assert.notEqual(f.client.view.history,prior);assert.equal(f.client.view.history[0].id,'new-authority');await f.close();assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('journal retry returns the recovered events while keeping its delivery owner until settlement',async()=>{
 const before=snapshot(),f=fixture(),gate=deferred(),events=[{type:'DocumentCreated'}];f.client.journal={get:async()=>({request:{command:{id:'known'}}}),close(){}};f.client.deliver=async()=>{await gate.promise;return events;};const work=f.client.retry('known');await flush();assert(snapshot().cpuBytes>before.cpuBytes+1024*1024);gate.resolve();assert.equal(await work,events);await f.close();assert.equal(snapshot().cpuBytes,before.cpuBytes);
});

// Exercise actual connect/dispose/DraftPersistence code. Only IndexedDB opens,
// native handle closes, recovery transport and sessionStorage are boundary
// doubles here; the separate browser remount test owns real IndexedDB coverage.
const ownershipTotals=()=>{const value=snapshot();return {cpuBytes:value.cpuBytes,gpuBytes:value.gpuBytes,handles:value.handles,activeRecords:value.activeRecords,promptBytes:value.promptBytes,unusedHandles:value.unusedHandles};};
const pendingAtTurn=promise=>Promise.race([promise.then(()=>false,()=>false),new Promise(resolve=>setImmediate(()=>resolve(true)))]);
const reached=(boundary,work,label)=>Promise.race([boundary,work.then(()=>{throw Error('Operation settled before '+label);})]);
function lifecycleFixture(){
 const caches=[],journals=[],consumers=[],events=[],requests=[],gates=[],openAttempts=[];
 const state={identity:'unchanged-client',viewReleaseFailure:null,viewReleaseGate:null,cacheGate:null,journalGate:null,journalOpenFailure:null,post:null,viewReleaseCalls:0};
 const assertOpen=handle=>{if(handle.closed)throw Error('Boundary handle already closed: '+handle.kind);};
 const handle=kind=>{const value={kind,index:kind==='cache'?caches.length:journals.length,closed:false,closeCalls:0,closeFailures:0,records:new Map(),
  close(){this.closeCalls++;events.push(kind+'-close-'+this.index);if(this.closeFailures){this.closeFailures--;throw Error(kind+' close refused');}this.closed=true;},
  async published(){assertOpen(this);return {generation:'stable',cursor:'0'};},async *rows(){assertOpen(this);},
  async put(key,value){assertOpen(this);this.records.set(key,structuredClone(value));},async scan(prefix,visit,{after=null,direction='next'}={}){assertOpen(this);const rows=[...this.records].filter(([key])=>key.startsWith(prefix)&&(!after||(direction==='prev'?key<after:key>after))).sort(([a],[b])=>a<b?-1:a>b?1:0);if(direction==='prev')rows.reverse();for(const [key,value] of rows)if(visit(value,key)===false)break;},async get(key){assertOpen(this);return this.records.get(key);},async has(key){assertOpen(this);return this.records.has(key);}
 };return value;};
 const open=async(kind,identity)=>{openAttempts.push({kind,identity});if(kind==='journal'&&state.journalOpenFailure){const error=state.journalOpenFailure;state.journalOpenFailure=null;throw error;}const value=handle(kind);value.identity=identity;(kind==='cache'?caches:journals).push(value);events.push(kind+'-open-'+value.index);const key=kind+'Gate',gate=state[key];state[key]=null;if(gate){gate.entered.resolve(value);await gate.release.promise;}return value;};
 clientBoundaries.storage=new Map([['ie-ui-session:unchanged-client','unchanged-ui-session'],['ie-ui-session:changed-client','changed-ui-session']]);
 clientBoundaries.cacheOpen=identity=>open('cache',identity);clientBoundaries.journalOpen=identity=>open('journal',identity);
 clientBoundaries.consumer=cache=>{const value={cache,cancelled:0,released:0,cancel(){this.cancelled++;},async release(){this.released++;},async recover(){assertOpen(cache);},consumeStream(signal){return new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});}};consumers.push(value);return value;};
 const session={identity:()=>state.identity,csrf:()=> 'test-csrf',async transport(path,init){
  requests.push({path,method:init?.method??'GET'});
  if(init?.method==='POST'){const request=JSON.parse(init.body);if(state.post)return state.post(request,init);return response({protocolVersion:1,requestId:request.requestId,status:'accepted',uiSeq:'1'});}
  if(path==='/api/v1/ui/unchanged-ui-session'||path==='/api/v1/ui/changed-ui-session')return response({protocolVersion:1,sessionId:path.slice('/api/v1/ui/'.length),uiSeq:'0',preferences:{documentId:null,selectedLayerIds:[]},drafts:[]});
  if(path==='/api/v1/ui')return response({kind:'ui-inventory',semantics:'current-at-page-read',items:[],next:null});
  if(path==='/api/v1/assets/staging/recovery')return response({protocolVersion:1,items:[],nextCursor:null});
  if(path==='/api/v1/commands/pending')return response({kind:'pending-inventory',semantics:'pending-at-page-read',items:[],next:null});
  throw Error('Unexpected lifecycle transport: '+path);
 }};
 const client=new EditorClient(session);
 // Controlled editor-owned boundary: always drain the actual view reader,
 // then inject the requested completion hold/refusal. Session is external.
 const releaseViewReads=client.viewReads.release.bind(client.viewReads);
 client.viewReads.release=async()=>{state.viewReleaseCalls++;await releaseViewReads();if(state.viewReleaseFailure)throw state.viewReleaseFailure;const gate=state.viewReleaseGate;state.viewReleaseGate=null;if(gate){gate.entered.resolve();await gate.release.promise;}};
 return {client,state,caches,journals,consumers,events,requests,openAttempts,hold(kind){const gate={entered:deferred(),release:deferred()};state[kind+'Gate']=gate;gates.push(gate);return gate;},async close(){state.viewReleaseFailure=null;for(const gate of gates)gate.release.resolve();for(const value of [...caches,...journals])value.closeFailures=0;await client.dispose();}};
}
test('confirmed disposal shares its promise and reconnect waits for the controlled release boundary',async()=>{
 const before=ownershipTotals(),f=lifecycleFixture();let disposal,reconnect;
 try{await f.client.connect();assert.equal(f.client.view.ready,true);const gate=f.hold('viewRelease');disposal=f.client.dispose();assert.equal(f.client.dispose(),disposal);await reached(gate.entered.promise,disposal,'editor view-reader release');
  reconnect=f.client.connect();assert.equal(await pendingAtTurn(disposal),true);assert.equal(await pendingAtTurn(reconnect),true);assert.equal(f.caches.length,1);assert.equal(f.journals[0].closed,false);assert.equal(f.client.view.ready,false);
  gate.release.resolve();await disposal;await reconnect;assert.equal(f.client.view.ready,true);assert.equal(f.caches.length,2);assert.equal(f.journals.length,2);assert(f.events.indexOf('journal-close-0')<f.events.indexOf('cache-open-1'));
 }finally{await f.close();await Promise.allSettled([disposal,reconnect].filter(Boolean));await f.close();}assert.deepEqual(ownershipTotals(),before);
});
test('failed disposal blocks reconnect until an explicit successful disposal retry',async()=>{
 const before=ownershipTotals(),f=lifecycleFixture();
 try{await f.client.connect();const releases=f.state.viewReleaseCalls;f.state.viewReleaseFailure=Error('Editor view-reader release refused');const failed=f.client.dispose();await assert.rejects(failed,/EDITOR_DISPOSAL_INCOMPLETE/);
  f.state.viewReleaseFailure=null;await assert.rejects(f.client.connect(),/EDITOR_DISPOSAL_INCOMPLETE/);assert.equal(f.state.viewReleaseCalls,releases+1);assert.equal(f.caches.length,1);assert.equal(f.client.view.ready,false);
  const retry=f.client.dispose();assert.notEqual(retry,failed);await retry;assert.equal(f.state.viewReleaseCalls,releases+2);await f.client.connect();assert.equal(f.client.view.ready,true);assert.equal(f.journals.length,2);
 }finally{await f.close();}assert.deepEqual(ownershipTotals(),before);
});
test('editor command cleanup retains session authority and leaves an active renewal for the final session disposal',async()=>{
 const before=ownershipTotals(),originalFetch=globalThis.fetch,session=createSessionClient(),client=new EditorClient(session),eventRead=deferred(),eventCancelled=deferred(),eventCancel=deferred(),renewRead=deferred();
 const sessionValue={protocolVersion:1,clientId:'lease-client',csrfToken:'fixture-csrf',sessionExpiresAt:'2099-01-01T00:00:00.000Z',idleExpiresAt:'2099-01-01T00:00:00.000Z'};
 const event={schemaVersion:1,payloadVersion:1,eventId:'event_1',workspaceSeq:'1',streamId:'portable',streamSeq:'1',documentId:null,resultingDocumentRevision:null,commandId:'command',correlationId:'correlation',causationId:null,transactionId:'transaction',writerEpoch:'1',recordedAt:'2026-09-30T00:00:00.000Z',type:'PortableCancelled',payload:{operationId:'operation'}};
 const bytes=Buffer.from(JSON.stringify(event)+'\n'),receipt={status:'accepted',commandId:'command',fromSeq:'1',toSeq:'1',documentRevision:null,transactionId:'transaction'},recovery={recoveryId:'recovery',writerEpoch:'1',projectionSchema:8,highWater:'1',expiresAt:'2099-01-01T00:00:00.000Z'};
 const ref={contentId:'content',url:'/api/v1/protocol-content/content?recoveryId=recovery',blob:{hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byteLength:String(bytes.length),mediaType:'application/x-ndjson'},encoding:'lp1-events-jsonl',recordCount:'1',expiresAt:recovery.expiresAt};
 const page={protocolVersion:1,kind:'batches',recovery,nextCursor:'1',more:false,batches:[{kind:'transaction-ref',transactionId:'transaction',fromSeq:'1',toSeq:'1',eventCount:'1',recovery,content:ref}]};
 let command,renewal,disposal,eventBody,renewBody,renewSignal,releaseAuthority,eventCancels=0,renewCancels=0,releases=0;
 // Only the HTTP endpoint is doubled. Session authority, value state, command
 // validation, owned readers, native streams and the allocation ledger are real.
 globalThis.fetch=async(url,init={})=>{
  const path=String(url);
  if(path==='/api/v1/session')return response(sessionValue);
  if(path==='/api/v1/capabilities')return response({protocolVersion:1,limits:[],profiles:[]});
  if(path==='/api/v1/session/renew'){assert.equal(new Headers(init.headers).get('X-App-CSRF'),'fixture-csrf');renewSignal=init.signal;renewBody=new ReadableStream({pull(){renewRead.resolve();},cancel(){renewCancels++;}},{highWaterMark:0});return new Response(renewBody,{headers:{'content-length':String(Buffer.byteLength(JSON.stringify(sessionValue)))}});}
  if(path==='/api/v1/commands/command/result')return response(page);
  if(path===ref.url){eventBody=new ReadableStream({start(controller){controller.enqueue(bytes);},pull(){eventRead.resolve();},cancel(){eventCancels++;eventCancelled.resolve();return eventCancel.promise;}},{highWaterMark:0});return new Response(eventBody,{headers:{etag:'"'+ref.blob.hash+'"','content-length':ref.blob.byteLength,'content-type':ref.blob.mediaType}});}
  if(path==='/api/v1/recovery/recovery/release'){assert.equal(init.method,'POST');assert.equal(new Headers(init.headers).get('X-App-CSRF'),'fixture-csrf');assert.deepEqual(JSON.parse(init.body),{protocolVersion:1});releaseAuthority={identity:session.identity(),csrf:session.csrf(),busy:session.state.value.get().busy};releases++;return new Response(null,{status:204});}
  throw Error('Unexpected session cleanup endpoint: '+path);
 };
 try{await session.resume();assert.equal(session.state.value.get().connection,'paired');assert.equal(session.identity(),'lease-client');
  command=client.controlReads.run(signal=>readCommandEvents(session.transport,receipt,signal));void command.catch(()=>{});await reached(eventRead.promise,command,'native event EOF read');assert.equal(eventBody.locked,true);
  renewal=session.renew();await reached(renewRead.promise,renewal,'native renewal body read');assert.equal(renewBody.locked,true);assert.equal(session.state.value.get().busy,true);
  disposal=client.dispose();await reached(eventCancelled.promise,disposal,'native event cancellation');assert.equal(await pendingAtTurn(disposal),true);assert.equal(releases,0);assert.equal(renewSignal.aborted,false);assert.equal(renewCancels,0);assert.equal(session.csrf(),'fixture-csrf');
  eventCancel.resolve();await disposal;await assert.rejects(command,{name:'AbortError'});assert.equal(eventCancels,1);assert.equal(eventBody.locked,false);assert.equal(releases,1);assert.deepEqual(releaseAuthority,{identity:'lease-client',csrf:'fixture-csrf',busy:true});assert.deepEqual(client.controlReads.ownership,{controlReads:0,controlCleanupFailures:0});
  assert.equal(await pendingAtTurn(renewal),true);assert.equal(renewSignal.aborted,false);assert.equal(renewCancels,0);assert.equal(renewBody.locked,true);assert.equal(session.identity(),'lease-client');assert.equal(session.csrf(),'fixture-csrf');assert.equal(session.state.value.get().busy,true);
  await session.dispose();await renewal;assert.equal(renewSignal.aborted,true);assert.equal(renewCancels,1);assert.equal(renewBody.locked,false);assert.equal(session.identity(),null);assert.equal(session.csrf(),'');assert.equal(session.ownership.sessionModels,0);
 }finally{eventCancel.resolve();try{const cleanup=client.dispose();await Promise.allSettled([command,disposal,cleanup].filter(Boolean));await cleanup;}finally{try{await session.dispose();await Promise.allSettled([renewal].filter(Boolean));}finally{globalThis.fetch=originalFetch;}}}assert.deepEqual(ownershipTotals(),before);
});
test('the same identity and UI session remount with fresh journal and actual draft persistence owners',async()=>{
 const before=ownershipTotals(),f=lifecycleFixture();
 try{await f.client.connect();const owner=f.client.draftOwner,sessionId=f.client.sessionId,journal=f.journals[0];assert(owner instanceof DraftPersistence);const release=owner.registerDraft('old-draft','document');release();
  await f.client.dispose();assert.equal(journal.closed,true);assert.throws(()=>owner.registerDraft('refused','document'),/DRAFT_OWNER_DISPOSED/);
  await f.client.connect();const replacement=f.client.draftOwner;assert(replacement instanceof DraftPersistence);assert.notEqual(replacement,owner);assert.equal(replacement.sessionId,sessionId);assert.equal(f.client.sessionId,sessionId);assert.notEqual(f.journals[1],journal);assert.equal(f.client.ui,replacement.checkpoint);assert.equal(f.client.view.ready,true);
  const releaseFresh=replacement.registerDraft('fresh-draft','document');replacement.change({id:'fresh-draft',kind:'prompt',text:'Editable after remount',documentId:'document',targetLayerId:null,expectedDocumentRevision:'1',composing:false});assert.equal(replacement.drafts.get('fresh-draft').text,'Editable after remount');releaseFresh();
 }finally{await f.close();}assert.deepEqual(ownershipTotals(),before);
});
test('a failed journal open for a changed identity cannot reuse the closed previous journal on reconnect',async()=>{
 const before=ownershipTotals(),f=lifecycleFixture();
 try{await f.client.connect();const journal=f.journals[0],owner=f.client.draftOwner;assert(owner instanceof DraftPersistence);assert.equal(journal.identity,'unchanged-client');
  f.state.identity='changed-client';f.state.journalOpenFailure=Error('Changed identity journal open refused');await assert.rejects(f.client.connect(),/Changed identity journal open refused/);
  assert.equal(journal.closed,true);assert.equal(journal.closeCalls,1);assert.equal(f.journals.length,1);assert.equal(f.client.view.ready,false);
  await f.client.connect();assert.deepEqual(f.openAttempts.filter(attempt=>attempt.kind==='journal').map(attempt=>attempt.identity),['unchanged-client','changed-client','changed-client']);assert.equal(journal.closeCalls,1);assert.equal(f.journals.length,2);assert.equal(f.journals[1].identity,'changed-client');assert.equal(f.journals[1].closed,false);
  const replacement=f.client.draftOwner;assert(replacement instanceof DraftPersistence);assert.notEqual(replacement,owner);assert.equal(replacement.sessionId,'changed-ui-session');assert.equal(f.client.sessionId,'changed-ui-session');assert.equal(f.client.ui,replacement.checkpoint);assert.equal(f.client.view.ready,true);assert.throws(()=>owner.registerDraft('refused','document'),/DRAFT_OWNER_DISPOSED/);
 }finally{await f.close();}assert.deepEqual(ownershipTotals(),before);
});
test('a previous identity journal close refusal requires explicit disposal before reconnect may open a successor',async()=>{
 const before=ownershipTotals(),f=lifecycleFixture();
 try{await f.client.connect();const journal=f.journals[0];journal.closeFailures=1;f.state.identity='changed-client';await assert.rejects(f.client.connect(),/journal close refused/);
  assert.equal(journal.closeCalls,1);assert.equal(journal.closed,false);const attempts=f.openAttempts.length;await assert.rejects(f.client.connect(),/journal close refused/);assert.equal(f.openAttempts.length,attempts);assert.equal(journal.closeCalls,1);
  await f.client.dispose();assert.equal(journal.closeCalls,2);assert.equal(journal.closed,true);await f.client.connect();assert.equal(f.client.view.ready,true);assert.equal(f.journals.length,2);assert.equal(f.journals[1].identity,'changed-client');assert.equal(f.client.sessionId,'changed-ui-session');
 }finally{await f.close();}assert.deepEqual(ownershipTotals(),before);
});
test('an explicit identity change waits for the old open and then starts a fresh connection for the new identity',async()=>{
 const before=ownershipTotals(),f=lifecycleFixture(),gate=f.hold('cache');let original,replacement;
 try{original=f.client.connect();const oldCache=await reached(gate.entered.promise,original,'original identity cache open');assert.equal(oldCache.identity,'ie-projection-unchanged-client');
  f.state.identity='changed-client';replacement=f.client.connect();assert.equal(await pendingAtTurn(replacement),true);assert.equal(f.caches.length,1);assert.equal(f.journals.length,0);assert.equal(oldCache.closed,false);
  gate.release.resolve();await Promise.all([original,replacement]);assert.equal(oldCache.closed,true);assert.equal(oldCache.closeCalls,1);assert.equal(f.caches.length,2);assert.equal(f.caches[1].identity,'ie-projection-changed-client');assert(f.events.indexOf('cache-close-0')<f.events.indexOf('cache-open-1'));assert.deepEqual(f.openAttempts.filter(attempt=>attempt.kind==='journal').map(attempt=>attempt.identity),['changed-client']);assert.equal(f.client.view.ready,true);assert.equal(f.client.sessionId,'changed-ui-session');assert(f.client.draftOwner instanceof DraftPersistence);
 }finally{gate.release.resolve();await Promise.allSettled([original,replacement].filter(Boolean));await f.close();}assert.deepEqual(ownershipTotals(),before);
});
test('a synchronous retired draft owner disposal failure still attempts siblings and retains only the failed owner for retry',async()=>{
 const before=ownershipTotals(),f=lifecycleFixture();let fail=true,firstCalls=0,secondCalls=0;
 // Deliberate internal owner-boundary doubles reproduce a synchronous throw
 // before a cleanup promise exists; actual EditorClient drain/dispose owns retry.
 const first={dispose(){firstCalls++;if(fail)throw Error('Retired owner release refused');return Promise.resolve();}},second={dispose(){secondCalls++;return Promise.resolve();}};
 f.client.retiredDraftOwners.add(first);f.client.retiredDraftOwners.add(second);
 try{await assert.rejects(f.client.dispose(),/EDITOR_DISPOSAL_INCOMPLETE/);assert.equal(firstCalls,1);assert.equal(secondCalls,1);assert.equal(f.client.retiredDraftOwners.has(first),true);assert.equal(f.client.retiredDraftOwners.has(second),false);assert.equal(f.client.retiredDraftOwners.size,1);
  await assert.rejects(f.client.connect(),/EDITOR_DISPOSAL_INCOMPLETE/);assert.equal(firstCalls,1);assert.equal(secondCalls,1);assert.equal(f.openAttempts.length,0);
  fail=false;await f.client.dispose();assert.equal(firstCalls,2);assert.equal(secondCalls,1);assert.equal(f.client.retiredDraftOwners.size,0);await f.client.connect();assert.equal(f.client.view.ready,true);
 }finally{fail=false;await f.close();}assert.deepEqual(ownershipTotals(),before);
});
for(const kind of ['cache','journal'])test('a late '+kind+' open is closed before a remount can create its successor',async()=>{
 const before=ownershipTotals(),f=lifecycleFixture(),gate=f.hold(kind);let connecting,disposal,reconnect;
 try{connecting=f.client.connect();const late=await reached(gate.entered.promise,connecting,kind+' open');disposal=f.client.dispose();reconnect=f.client.connect();assert.equal(await pendingAtTurn(disposal),true);assert.equal(await pendingAtTurn(reconnect),true);
  gate.release.resolve();await connecting;await disposal;await reconnect;assert.equal(late.closed,true);assert.equal(late.closeCalls,1);assert.equal(f.client.view.ready,true);assert.equal(f.caches.length,2);assert(f.events.indexOf(kind+'-close-0')<f.events.indexOf('cache-open-1'));
 }finally{gate.release.resolve();await Promise.allSettled([connecting,disposal,reconnect].filter(Boolean));await f.close();}assert.deepEqual(ownershipTotals(),before);
});
for(const kind of ['cache','journal'])test('a one-time late '+kind+' close failure remains failed until a later explicit disposal retries it',async()=>{
 const before=ownershipTotals(),f=lifecycleFixture(),gate=f.hold(kind);let connecting,disposal;
 try{connecting=f.client.connect();void connecting.catch(()=>{});const late=await reached(gate.entered.promise,connecting,kind+' open');late.closeFailures=1;disposal=f.client.dispose();gate.release.resolve();
  await assert.rejects(connecting,new RegExp(kind+' close refused'));await assert.rejects(disposal,/EDITOR_DISPOSAL_INCOMPLETE/);assert.equal(late.closeCalls,1,'The same disposal must not silently retry a newly failed native close');assert.equal(late.closed,false);
  await assert.rejects(f.client.connect(),/EDITOR_DISPOSAL_INCOMPLETE/);assert.equal(late.closeCalls,1);assert.equal(f.caches.length,1);
  await f.client.dispose();assert.equal(late.closeCalls,2);assert.equal(late.closed,true);await f.client.connect();assert.equal(f.client.view.ready,true);assert.equal(f.caches.length,2);
 }finally{gate.release.resolve();await Promise.allSettled([connecting,disposal].filter(Boolean));await f.close();}assert.deepEqual(ownershipTotals(),before);
});
test('a draft flush waiting on actual draft receipt cleanup cannot publish after disposal',async()=>{
 const before=ownershipTotals(),f=lifecycleFixture(),entered=deferred(),cancelled=deferred(),cancel=deferred();let preferences,flushDrafts,disposal;
 try{await f.client.connect();const owner=f.client.draftOwner;assert(owner instanceof DraftPersistence);
  const release=owner.registerDraft('waiting-draft','document');owner.change({id:'waiting-draft',kind:'prompt',text:'Retained current input',documentId:'document',targetLayerId:null,expectedDocumentRevision:'1',composing:false});release();
  f.state.post=()=>responseStream();function responseStream(){return new Response(new ReadableStream({pull(){entered.resolve();},cancel(){cancelled.resolve();return cancel.promise;}}),{headers:{'content-length':'64'}});}
  preferences=f.client.preferences({selectedLayerIds:[]});void preferences.catch(()=>{});await reached(entered.promise,preferences,'draft receipt stream read');
  flushDrafts=f.client.flushDrafts();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.client.view.drafts,'Draft saving…');
  disposal=f.client.dispose();await reached(cancelled.promise,disposal,'native receipt cancellation');const terminal=f.client.view;assert.equal(terminal.ready,false);assert.equal(terminal.drafts,'');assert.equal(await pendingAtTurn(disposal),true);
  cancel.resolve();await Promise.allSettled([preferences]);await flushDrafts;await disposal;assert.equal(f.client.view,terminal);assert.equal(f.client.ui,undefined);assert.equal(f.requests.some(request=>request.path.startsWith('/api/v1/assets/staging')&&request.method==='POST'),false);
  f.state.post=null;await f.client.connect();assert.equal(f.client.view.ready,true);assert.notEqual(f.client.draftOwner,owner);assert.equal(f.client.draftOwner.drafts.size,0);
 }finally{cancel.resolve();await Promise.allSettled([preferences,flushDrafts,disposal].filter(Boolean));await f.close();}assert.deepEqual(ownershipTotals(),before);
});

const layer={id:'l',version:'1',kind:'image',assetId:'asset',name:'layer',locked:false,visible:true,opacity:1,appearanceDescription:'',layerToDocument:[1,0,0,1,0,0]},document={id:'d',revision:'1',orderedLayerIds:['large-borrowed-root']};
test('inspector snapshot contains only needed provenance, admits edits and pins async work',()=>{
 const before=snapshot(),first=newInspector(layer,document,'draft'),unpin=first.pin();assert.deepEqual(first.value.document,{id:'d',revision:'1'});assert.equal(first.value.layer.layerToDocument,undefined);const next=ownInspector({...first.value,values:{...first.value.values,name:'next'},dirty:true});first.release();assert(snapshot().cpuBytes>modelPayloadBytes(next.value));unpin();assert.throws(()=>ownInspector({...next.value,values:{...next.value.values,name:'a'.repeat(INSPECTOR_MODEL_BYTES)}}),/previous draft is retained/);assert.equal(next.value.values.name,'next');const restored=restoredInspector(next.value,JSON.stringify({...next.value.values,name:'saved'}),'0','saved-draft');assert.equal(restored.value.document.revision,'0');restored.release();next.release();assert.equal(snapshot().cpuBytes,before.cpuBytes);
});

// Execute the real shell class methods; browser/Lit mounting and transport are
// boundary doubles. Object.create avoids unrelated constructor/native setup.
const shellCompiled=(await transformWithOxc(await readFile(root+'/src/ui/shell.ts','utf8'),'shell.ts')).code;
const shellClass=shellCompiled.slice(shellCompiled.indexOf('class EditorShell'),shellCompiled.lastIndexOf('scope.register('));
const assetProjectionURL=pathToFileURL(resolve('dist/local/src/protocol/asset-projection.js')).href;
const shellModule=await import(data(`import {allocationLedger} from ${JSON.stringify(allocations)};import {newInspector,ownInspector,restoredInspector,serializedInspector,changedInspector,inspectorTransform,sizedInspector,friendlyInspectorAvailable} from ${JSON.stringify(inspector)};import {cloneOwnedModel} from ${JSON.stringify(memory)};import {SHA256} from ${JSON.stringify(sha)};import {ViewModelReads} from ${JSON.stringify(owners)};import {validateAssetProjection} from ${JSON.stringify(assetProjectionURL)};class LitElement{};let editor;export function setEditor(value){editor=value;}\n`+shellClass+'\nexport {EditorShell};'));
function shellFixture(){const writes=[],view={document,selected:['l'],image:{layers:[]}},editor={view,documentResources:{releasing:true},sessionId:'session',changeDraft(...args){writes.push(args);},flushDrafts:async()=>{},withCommandEvents:async(_body,consume)=>consume([]),draftOwner:{drafts:new Map()},fail(){}};shellModule.setEditor(editor);const shell=Object.create(shellModule.EditorShell.prototype);Object.assign(shell,{inspectorTasks:new Set(),inspectorSizeReads:new ViewModelReads(),inspectorKey:'d:l',adapter:{invalidate(){}},requestUpdate(){},updateComplete:Promise.resolve(),writeFields(){},restoreInspector:async()=>{}});shell.setFields(newInspector(layer,document,'draft'));return {shell,editor,writes};}
test('inspector successor key is published only after snapshot admission and stale input cannot save into it',async()=>{
 const before=snapshot(),f=shellFixture(),prior=f.shell.fields,nextDocument={...document,id:'successor'};f.editor.view.document=nextDocument;
 assert.throws(()=>f.shell.syncInspector({...layer,name:'a'.repeat(INSPECTOR_MODEL_BYTES)},nextDocument),/previous draft is retained/);assert.equal(f.shell.inspectorKey,'d:l');assert.equal(f.shell.fields,prior);assert.throws(()=>f.shell.editInspector('name','wrong document'),/DOCUMENT_CHANGED/);assert.equal(f.writes.length,0);
 f.shell.syncInspector(layer,nextDocument);await flush();assert.equal(f.shell.inspectorKey,'successor:l');assert.equal(f.shell.fields.document.id,'successor');f.shell.setFields();assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('inspector serialization refusal retains prior snapshot before draft publication',()=>{
 const before=snapshot(),f=shellFixture(),prior=f.shell.fields,next={...prior,values:{...prior.values,name:'next'},dirty:true},room=modelPayloadBytes(next),held=snapshot(),blocker=allocationLedger.reserve({owner:'view-test-blocker',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-held.cpuBytes-room});
 try{assert.throws(()=>f.shell.editInspector('name','next'),/ALLOCATION_BUDGET/);assert.equal(f.shell.fields,prior);assert.equal(f.writes.length,0);}finally{blocker.release();f.shell.setFields();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('inspector action drain waits for a pinned command after visible fields are cleared',async()=>{
 const before=snapshot(),f=shellFixture(),command=deferred(),entered=deferred();let drained=false,consumed=false,drain;
 // The actual shell consumes an owned response callback. Hold that current API
 // boundary, retaining its exact version-fenced body/document until settlement.
 f.editor.withCommandEvents=async(body,consume,capturedDocument)=>{assert.deepEqual(body,{type:'SetLayerProperties',layerId:'l',layerVersion:'1',properties:{name:'layer',opacity:1,visible:true,locked:false},draft:null});assert.deepEqual(capturedDocument,{id:'d',revision:'1'});entered.resolve();await command.promise;const result=await consume([]);consumed=true;return result;};
 const work=f.shell.applyFields('properties');void work.catch(()=>{});
 try{await Promise.race([entered.promise,work.then(()=>{throw Error('Inspector action settled before entering the command boundary');})]);f.shell.setFields();f.editor.view.document=null;drain=f.shell.drainInspector().then(()=>{drained=true;});await flush();assert.equal(drained,false);assert.equal(consumed,false);await assert.rejects(f.shell.applyFields('properties'),{name:'AbortError'});assert(snapshot().cpuBytes>before.cpuBytes);command.resolve();await work;await drain;assert.equal(consumed,true);assert.equal(f.shell.inspectorTasks.size,0);}
 finally{command.resolve();await Promise.allSettled(drain?[work,drain]:[work]);f.shell.setFields();await f.shell.drainInspector();}
 assert.equal(snapshot().cpuBytes,before.cpuBytes);
});

test('model-ready follows successful authoritative publication, never a pending HEAD read',async()=>{
 const before=snapshot(),f=fixture(true);let work;try{
  f.state.head=deferred();work=f.client.loadDocument(f.document);void work.catch(()=>{});await flush();assert.equal(navigation.copy(),null);assert.equal(f.client.view.image,null);
  f.state.head.resolve();await work;const row=navigation.copy();assert.deepEqual(row.identity,{...f.client.navigationTarget(),snapshotId:'g'});assert.equal(row.modelReadyMs!==null,true);assert.equal(row.renderSubmittedMs,null);assert.equal(row.editAvailableMs,null);assert.equal(f.client.view.image.layers[0].id,'a');
 }finally{f.state.head?.resolve();await Promise.allSettled(work?[work]:[]);await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
for(const stale of ['revision','publication','lifetime','image-hash','session'])test(`model-ready is absent when recovery ${stale} changes before publication`,async()=>{
 const before=snapshot(),f=fixture(true);let work;try{
  f.state.head=deferred();if(stale==='image-hash')f.state.image=image('changed');work=f.client.loadDocument(f.document);void work.catch(()=>{});await flush();
  if(stale==='revision')f.state.headVersion='2';if(stale==='publication')f.state.publishedGeneration='next';if(stale==='lifetime')f.client.lifecycle++;if(stale==='session')f.client.owner='changed';
  f.state.head.resolve();await work;assert.equal(navigation.copy(),null);
 }finally{f.state.head?.resolve();await Promise.allSettled(work?[work]:[]);await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('blank documents and refused child responses do not manufacture model or pixel milestones',async()=>{
 const before=snapshot(),blank=fixture();try{await blank.client.loadDocument(blank.document);assert.equal(navigation.copy(),null);}finally{await blank.close();}
 const refused=fixture(true);try{refused.state.badHistory=true;await assert.rejects(refused.client.loadDocument(refused.document),/DOCUMENT_MODEL_READ_FAILED/);assert.equal(navigation.copy(),null);}finally{await refused.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('replacing accepted document metadata clears old navigation identity before the successor load',async()=>{
 const before=snapshot(),f=fixture(true);try{await f.client.loadDocument(f.document);assert(navigation.copy());f.client.patch({document:{...f.document,revision:'2'}});assert.equal(navigation.copy(),null);}finally{await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});

function navigationShellFixture(){
 const records=[],load=deferred(),d={id:'nav-document',revision:'1',width:10,height:10,image:{state:{hash:'sha256:'+'a'.repeat(64)},compositeAssetId:'nav-asset'}},session={identity:()=> 'writer'};
 const editor={session,sessionId:'ui-session',documentEpoch:1,view:{document:d,ready:true,busy:false},navigationTarget(){const d=this.view.document;return d?.image?.compositeAssetId?{sessionId:this.sessionId,generation:this.documentEpoch,documentId:d.id,revision:d.revision,assetId:d.image.compositeAssetId,assetHash:d.image.state.hash}:null;},navigationViewportUnavailable(){records.push(['unavailable']);},navigationRenderSubmitted(){records.push(['submitted',this.navigationTarget()]);},viewportDecoded(target){records.push(['decoded',target]);}};
 shellModule.setEditor(editor);let decoded='nav-asset',submitted=true;const canvas={ownership:{suspended:false,contextLost:false,contextRestoring:false},get decodedAssetId(){return decoded;},show:()=>load.promise,draw:()=>submitted};
 const shell=Object.create(shellModule.EditorShell.prototype);Object.assign(shell,{canvas,isConnected:true,renderGeneration:0,zoom:1,pan:{x:0,y:0},reviewedCanvasPreview:null,requestUpdate(){},authoring:{overlay(){}},semantic:{overlay(){}},textEditing:{overlay(){}}});
 return {shell,editor,canvas,records,load,decoded(value){decoded=value;},submitted(value){submitted=value;}};
}
for(const change of ['session','epoch','revision','image-hash','canvas','disconnected'])test(`late canonical paint cannot report completion after ${change} changes with the same asset`,async()=>{
 const f=navigationShellFixture(),work=f.shell.paint();
 if(change==='session')f.editor.sessionId='successor';if(change==='epoch')f.editor.documentEpoch++;if(change==='revision')f.editor.view.document={...f.editor.view.document,revision:'2'};if(change==='image-hash')f.editor.view.document={...f.editor.view.document,image:{...f.editor.view.document.image,state:{hash:'sha256:'+'b'.repeat(64)}}};if(change==='canvas')f.shell.canvas={...f.canvas};if(change==='disconnected')f.shell.isConnected=false;
 f.load.resolve();await work;assert.equal(f.records.some(([kind])=>kind==='submitted'||kind==='decoded'),false);
});
test('a later real tile draw can establish canonical submission after the first draw is incomplete',async()=>{
 const f=navigationShellFixture();f.submitted(false);const work=f.shell.paint();f.load.resolve();await work;assert.equal(f.records.some(([kind])=>kind==='decoded'||kind==='submitted'),false);
 f.submitted(true);f.decoded('nav-asset');assert.equal(f.shell.draw(),true);assert.equal(f.records.filter(([kind])=>kind==='submitted').length,1);
 f.shell.reviewedCanvasPreview={reviewId:'review'};f.shell.draw();assert.equal(f.records.filter(([kind])=>kind==='submitted').length,1);assert.equal(f.records.at(-1)[0],'unavailable');
});

// Register cleanup only after all top-level asynchronous fixture imports and
// test declarations; the shared observation owner must outlive every client.
test.after(()=>navigation.dispose());

// Same-revision refresh and draft-triggered view reads may overlap. Native HEAD
// gates control only completion order; actual collection, read validation,
// publication, document pins and render/action borrows run unchanged.
for(const first of ['replacement','retained-selection'])test(`same-revision document rows remain owned when ${first} finishes first`,async()=>{
 const before=ownershipTotals(),f=fixture(),gates=[{entered:deferred(),release:deferred()},{entered:deferred(),release:deferred()}];let older,replacement,head=0;
 try{
  await f.client.loadDocument(f.document);const oldOwner=f.client.documentsMetadata,oldRow=f.client.view.document;
  const roots={image:f.client.view.image,history:f.client.view.history,checkpoints:f.client.view.checkpoints,save:f.client.view.save};
  const transport=f.client.session.transport;f.client.session.transport=async(path,init)=>{if(init?.method==='HEAD'){const gate=gates[head++];assert(gate,'Only the two overlapping loads reach HEAD');gate.entered.resolve();await gate.release.promise;}return transport(path,init);};
  f.client.cache.rows=async function*(generation,type){assert.equal(generation,'g');assert.equal(type,'document');yield {value:structuredClone(oldRow)};};
  older=f.client.loadDocument(oldRow);void older.catch(()=>{});await reached(gates[0].entered.promise,older,'the retained row HEAD');
  replacement=f.client.refresh();void replacement.catch(()=>{});await reached(gates[1].entered.promise,replacement,'the replacement row HEAD');
  const nextOwner=f.client.documentsMetadata,nextRow=f.client.view.documents[0];
  assert.notEqual(nextOwner,oldOwner);assert.notEqual(nextRow,oldRow);assert.equal(nextRow.id,oldRow.id);assert.equal(nextRow.revision,oldRow.revision);assert.equal(f.state.publishedGeneration,'g');
  assert.equal(f.client.view.document,oldRow);assert.equal(f.client.selectedDocumentMetadata,oldOwner);
  const borrow=(row,owner)=>{const descriptors=f.client.renderViewModels(row);assert.equal(descriptors.length,1);assert.equal(descriptors[0].value,owner.documents);const unpin=descriptors[0].pin();unpin();const release=f.client.pinViewModels(row);release();};
  if(first==='replacement'){
   gates[1].release.resolve();await replacement;const accepted=f.client.view;assert.equal(accepted.document,nextRow);borrow(nextRow,nextOwner);
   gates[0].release.resolve();await older;assert.equal(f.client.view,accepted,'A completed old row cannot overwrite the newer owned view');
   assert.throws(()=>f.client.renderViewModels(oldRow),/VIEW_MODEL_UNOWNED/);assert.throws(()=>f.client.pinViewModels(oldRow),/VIEW_MODEL_UNOWNED/);
  }else{
   gates[0].release.resolve();await older;assert.equal(f.client.view.document,oldRow);assert.equal(f.client.selectedDocumentMetadata,oldOwner);borrow(oldRow,oldOwner);
   gates[1].release.resolve();await replacement;
  }
  assert.equal(head,2);assert.equal(f.client.view.document,nextRow);assert.equal(f.client.selectedDocumentMetadata,nextOwner);borrow(nextRow,nextOwner);
  for(const [name,value]of Object.entries(roots))assert.equal(f.client.view[name],value,'The regression must reach the document-row boundary with unchanged reused '+name);
  assert.equal(f.client.viewReads.ownership.activeReads,0);assert.equal(f.client.viewModels.ownership.retiredPinnedRoots,0);assert.equal(f.client.viewModels.ownership.activePins,0);
 }finally{for(const gate of gates)gate.release.resolve();await Promise.allSettled([older,replacement].filter(Boolean));await f.close();}
 assert.deepEqual(ownershipTotals(),before);
});

// Source-derived wakeup regression, independent of any recorded browser cause.
// Actual EditorClient scheduling/refresh/read/ownership methods run unchanged.
// Only the established cache/transport/consumer boundaries and interval delivery
// are controlled; this does not qualify native IndexedDB or browser timing.
for(const pollAt of ['during-held-read','after-stale-read'])test(`same-cursor generation replacement converges when polled ${pollAt}`,async t=>{
 const before=ownershipTotals(),f=fixture(true),gates=[{entered:deferred(),release:deferred()},{entered:deferred(),release:deferred()}];
 const timers=new Map(),nativeClearInterval=globalThis.clearInterval;let serial=0,heads=0,streams=0,recoveries=0,closed=0,first;
 let published={generation:'baseline',cursor:'1',epoch:'1'},document=structuredClone(f.document);const seen=[];
 t.mock.method(globalThis,'setInterval',(callback,delay)=>{assert.equal(delay,100);const timer={id:++serial};timers.set(timer,callback);return timer;});
 t.mock.method(globalThis,'clearInterval',timer=>{if(!timers.delete(timer))nativeClearInterval(timer);});
 const turn=()=>new Promise(resolve=>setImmediate(resolve));
 const drainRefresh=async()=>{await turn();let count=0;while(f.client.refreshTask){assert(++count<=4,'The finite two-publication fixture must settle without a refresh loop');await f.client.refreshTask;await turn();}};
 const poll=async()=>{assert.equal(timers.size,1);[...timers.values()][0]();await turn();};
 const transport=f.client.session.transport;
 f.client.session.identity=()=> 'same-cursor-owner';f.client.owner='same-cursor-owner';
 f.client.session.transport=async(path,init)=>{
  assert.notEqual(init?.method,'POST','No command or recovery request may repair this controlled wakeup');
  if(init?.method==='HEAD'&&f.state.headVersion==='2'){
   const gate=gates[heads++];assert(gate,'At most the stale read and its one successor may reach the version fence');gate.entered.resolve();await gate.release.promise;
  }
  return transport(path,init);
 };
 f.client.cache={
  async published(){seen.push({...published});return {...published};},
  async *rows(generation,type){assert.equal(generation,published.generation);assert.equal(type,'document');yield {value:structuredClone(document)};},
  async read(type,id){return type==='document'&&id===document.id?structuredClone(document):null;},
  close(){closed++;}
 };
 f.client.consumer={
  cancel(){},async release(){},async recover(){recoveries++;assert.fail('An unrelated recovery must not supply this wakeup');},
  consumeStream(signal){streams++;return new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});}
 };
 try{
  await f.client.loadDocument(f.document);f.client.patch({cursor:'1'});const original=f.client.view.document,originalImage=f.client.view.image;
  f.client.startStream(f.client.lifecycle);await poll();await drainRefresh();assert.equal(streams,1);assert.equal(f.client.view.document.revision,'1');
  const changed={...image('a'),layers:[{id:'a',name:'a',opacity:0.5}]};
  document={...document,revision:'2',image:{...document.image,state:{...document.image.state,hash:canonicalControlHash(changed)}}};
  f.state.image=changed;f.state.headVersion='2';published={generation:'first-new',cursor:'2',epoch:'1'};
  await poll();first=f.client.refreshTask;assert(first,'Changed cursor must start the actual refresh');await reached(gates[0].entered.promise,first,'the first real document version fence');
  assert.equal(f.client.view.cursor,'2');assert.equal(f.client.view.document.revision,'1');assert.equal(f.client.view.image,originalImage);
  // Both publications describe the same exact committed row and cursor. Only
  // generation changes, as when another consumer replays that same boundary.
  published={generation:'replacement',cursor:'2',epoch:'1'};
  if(pollAt==='during-held-read')await poll();
  gates[0].release.resolve();await first;
  // The second HEAD remains gated, so a fresh read cannot mask stale admission.
  assert.equal(f.client.view.document.revision,'1','The retired first-new generation must not publish');assert.equal(f.client.view.image,originalImage);
  if(pollAt==='after-stale-read')await poll();
  gates[1].release.resolve();await drainRefresh();
  assert(seen.some(value=>value.generation==='replacement'&&value.cursor==='2'));
  assert.equal(recoveries,0);assert.equal(streams,1);assert.equal(f.client.view.cursor,'2');
  assert.equal(f.client.view.document.revision,'2','A same-cursor replacement must wake the real refresh without another transaction');
  assert.equal(f.client.view.image.layers[0].opacity,0.5);assert.equal(heads,2);assert.equal(f.client.view.error,'');
  assert.notEqual(f.client.view.document,original);const [owned]=f.client.renderViewModels(f.client.view.document);assert.equal(owned.value,f.client.view.documents);const unpin=owned.pin();unpin();
  assert.equal(f.client.viewReads.ownership.activeReads,0);assert.equal(f.client.viewModels.ownership.retiredPinnedRoots,0);assert.equal(f.client.viewModels.ownership.activePins,0);
 }finally{
  for(const gate of gates)gate.release.resolve();await Promise.allSettled(first?[first]:[]);
  try{await f.close();}finally{assert.equal(timers.size,0);assert.equal(closed,1);assert.equal(recoveries,0);assert.deepEqual(ownershipTotals(),before);}
 }
});


// Real collect/refresh/load/publish behavior supplies the reusable observation.
// Controlled cache rows, transport and interval delivery only; no browser or
// IndexedDB qualification is supplied by this deterministic scheduling fixture.
function refreshReuseFixture(t){
 const f=fixture(true),timers=new Map(),nativeClearInterval=globalThis.clearInterval;
 const state=Object.assign(f.state,{pointer:{generation:'reuse-generation',cursor:'1',epoch:'1'},identity:'reuse-owner',closed:0,streams:0}),document=structuredClone(f.document);
 t.mock.method(globalThis,'setInterval',(work,delay)=>{assert.equal(delay,100);const id={};timers.set(id,work);return id;});
 t.mock.method(globalThis,'clearInterval',id=>{if(!timers.delete(id))nativeClearInterval(id);});
 f.client.owner=state.identity;f.client.session.identity=()=>state.identity;
 f.client.cache={async published(){return {...state.pointer};},async *rows(generation,type){assert.equal(generation,state.pointer.generation);assert.equal(type,'document');yield {value:structuredClone(document)};},async read(type,id){return type==='document'&&id===document.id?structuredClone(document):null;},close(){state.closed++;}};
 f.client.consumer={cancel(){},async release(){},async recover(){assert.fail('No recovery may manufacture a publication in this fixture');},consumeStream(signal){state.streams++;return new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});}};
 const turn=()=>new Promise(resolve=>setImmediate(resolve));
 const settle=async()=>{await turn();for(let count=0;f.client.refreshTask;count++){assert(count<4,'Finite publication changes must settle');await f.client.refreshTask;await turn();}};
 return {...f,state,timers,turn,settle,start(){f.client.startStream(f.client.lifecycle);},async poll(){assert.equal(timers.size,1);[...timers.values()][0]();await settle();},async stop(){f.client.stream.abort();await f.client.streamTask;assert.equal(timers.size,0);},async close(){try{await f.close();}finally{assert.equal(timers.size,0);assert.equal(f.client.viewReads.ownership.activeReads,0);}}};
}

test('a completed owned refresh prevents duplicate save and version reads across stream restart',async t=>{
 const before=ownershipTotals(),f=refreshReuseFixture(t);try{
  await f.client.refresh();const accepted=f.client.view,requests=f.calls.length;assert.equal(requests,5);
  f.client.patch({message:'Unrelated feedback remains visible.'});f.start();await f.poll();await f.poll();
  assert.equal(f.calls.length,requests,'The first pointer tick must not reread an accepted unchanged publication');
  assert.equal(f.client.view.document,accepted.document);assert.equal(f.client.view.image,accepted.image);
  await f.stop();f.start();await f.poll();assert.equal(f.calls.length,requests,'Restart alone creates no new model authority');assert.equal(f.state.streams,2);
 }finally{await f.close();}assert.deepEqual(ownershipTotals(),before);
});

for(const field of ['generation','cursor','epoch'])test(`accepted refresh reuse still wakes for a changed ${field}`,async t=>{
 const before=ownershipTotals(),f=refreshReuseFixture(t);try{
  await f.client.refresh();const requests=f.calls.length;f.start();await f.poll();assert.equal(f.calls.length,requests);
  f.state.pointer={...f.state.pointer,[field]:field==='generation'?'new-generation':'2'};await f.poll();
  assert.equal(f.calls.length,requests+2,'A changed publication reads current save status and document version');
  assert.equal(f.client.view.document.revision,'1');const updated=f.calls.length;await f.poll();assert.equal(f.calls.length,updated);
 }finally{await f.close();}assert.deepEqual(ownershipTotals(),before);
});

for(const refusal of ['version','response','cancelled'])test(`stream restart retries after an unsuccessful ${refusal} refresh`,async t=>{
 const before=ownershipTotals(),f=refreshReuseFixture(t);let work,drain,gate;try{
  await f.client.refresh();const accepted=f.client.view.document;
  if(refusal==='version'){f.state.headVersion='2';await f.client.refresh();f.state.headVersion='1';}
  else if(refusal==='response'){f.state.badHistory=true;f.client.lifecycle++;await assert.rejects(f.client.refresh(),/DOCUMENT_MODEL_READ_FAILED/);f.state.badHistory=false;}
  else{
   gate=deferred();const entered=deferred(),transport=f.client.session.transport;f.state.head=gate;
   f.client.session.transport=async(path,init)=>{if(init?.method==='HEAD')entered.resolve();return transport(path,init);};
   work=f.client.refresh();await reached(entered.promise,work,'the cancellable version read');drain=f.client.viewReads.release();gate.resolve();await Promise.all([work,drain]);f.state.head=null;
  }
  assert.equal(f.client.view.document,accepted,'The unsuccessful read retains the accepted document');
  const requests=f.calls.length;f.start();await f.poll();assert(f.calls.length>=requests+2,'A failed or aborted attempt is never an acknowledged publication');
  assert.equal(f.client.view.document.revision,'1');assert.equal(f.client.view.image.layers[0].id,'a');
 }finally{gate?.resolve();await Promise.allSettled([work,drain].filter(Boolean));await f.close();}assert.deepEqual(ownershipTotals(),before);
});

for(const replacement of ['cache','lifecycle','documentLifetime','owner','session-identity','image','history','checkpoints','save','documents'])test(`stream restart cannot reuse refresh after ${replacement} replacement`,async t=>{
 const before=ownershipTotals(),f=refreshReuseFixture(t);try{
  await f.client.refresh();const requests=f.calls.length;
  if(replacement==='cache')f.client.cache={...f.client.cache};
  else if(replacement==='lifecycle')f.client.lifecycle++;
  else if(replacement==='documentLifetime')f.client.documentLifetime++;
  else if(replacement==='owner')f.client.owner='new-owner';
  else if(replacement==='session-identity')f.state.identity='new-session-identity';
  else if(replacement==='save')f.client.patchSave({draftDirty:true});
  else if(replacement==='documents'){
   const prior=f.client.documentsMetadata,model=cloneOwnedModel('refresh-replacement-documents',structuredClone(f.client.view.documents));
   f.client.documentsMetadata={documents:model.value,pin:()=>model.pin(),release:()=>model.release()};f.client.patch({documents:model.value});prior.release();
  }else{
   const value=replacement==='image'?image('replacement'):{items:[],next:null},model=cloneOwnedModel('refresh-replacement-'+replacement,value),exposed=replacement==='image'?model.value:model.value.items;
   f.client.publishViewModels([f.client.viewInput(replacement,model,'explicit-replacement',exposed)],{[replacement]:exposed});
  }
  f.start();await f.poll();assert(f.calls.length>=requests+2,'Changed authority requires a real read');
  assert.equal(f.client.view.document.revision,'1');assert.equal(f.client.view.image.layers[0].id,'a');
 }finally{await f.close();}assert.deepEqual(ownershipTotals(),before);
});

test('root replacement after accepted load settlement cannot acknowledge the older refresh',async t=>{
 const before=ownershipTotals(),f=refreshReuseFixture(t);try{
  const original=f.client.loadDocument.bind(f.client);let changed=false;
  f.client.loadDocument=async document=>{const result=await original(document);if(!changed){changed=true;f.client.patchSave({draftDirty:true});}return result;};
  await f.client.refresh();assert.equal(f.client.view.save.draftDirty,true);const requests=f.calls.length;
  f.start();await f.poll();assert.equal(f.calls.length,requests+2,'The older accepted result cannot authorize a replacement view root');assert.equal(f.client.view.save.draftDirty,false);
 }finally{await f.close();}assert.deepEqual(ownershipTotals(),before);
});


for(const secondDocument of ['added','deleted'])test(`mixed list and selected-document publications cannot hide a ${secondDocument} document after restart`,async t=>{
 const before=ownershipTotals(),f=refreshReuseFixture(t),other={id:'other',revision:'1',orderedLayerIds:[]};let switched=false;
 try{
  const selected=structuredClone(f.document),initial=[selected,...(secondDocument==='deleted'?[other]:[])],replacement=[selected,...(secondDocument==='added'?[other]:[])];
  const g1={generation:'list-g1',cursor:'7',epoch:'1'},g2={generation:'selected-g2',cursor:'7',epoch:'1'};f.state.pointer=g1;
  f.client.cache.rows=async function*(generation,type){assert.equal(type,'document');const rows=generation===g1.generation?initial:generation===g2.generation?replacement:null;assert(rows,'No unrelated publication repairs the fixture');for(const row of rows)yield {value:structuredClone(row)};};
  const load=f.client.loadDocument.bind(f.client);f.client.loadDocument=async document=>{
   if(!switched){switched=true;assert.equal(f.client.documentsMetadata.publication.generation,g1.generation);f.state.pointer=g2;}
   return load(document);
  };
  await f.client.refresh();assert.deepEqual(f.client.view.documents.map(row=>row.id),initial.map(row=>row.id));assert.equal(f.client.view.document.id,selected.id);assert.equal(f.client.view.document.revision,selected.revision);
  const requests=f.calls.length;f.start();await f.poll();
  assert.equal(f.calls.length,requests+2,'A completed selected-document load cannot acknowledge a list collected from another generation');
  assert.deepEqual(f.client.view.documents.map(row=>row.id),replacement.map(row=>row.id));assert.deepEqual(f.client.documentsMetadata.publication,g2);
  assert.equal(f.client.view.document.id,selected.id);assert.equal(f.client.view.document.revision,selected.revision);
  const accepted=f.calls.length;await f.poll();assert.equal(f.calls.length,accepted,'The joined current publication may then be reused');
 }finally{await f.close();}assert.deepEqual(ownershipTotals(),before);
});

// Actual editor read/command owners; transport and command settlement are held
// only at their external boundaries. No timer guesses or browser-error filtering.
function deletionReadFixture(){
 const f=fixture(),state={identity:'client',commands:[],refreshes:0};
 f.client.session.identity=()=>state.identity;f.client.owner='client';f.client.journal={close(){}};
 f.client.refresh=async()=>{state.refreshes++;};
 const body={type:'DeleteDocument',documentId:'d',planId:'plan',planHash:'sha256:'+'a'.repeat(64),expectedRevision:'1',rootGeneration:'sha256:'+'b'.repeat(64),acknowledgeRunningAndUncertain:true};
 f.client.ownedCommand=async value=>{state.commands.push(value);f.client.patch({document:null,image:null,history:[],checkpoints:[],save:null});return cloneOwnedModel('delete-test-events',[{type:'DocumentDeleted',payload:{id:'d'}}]);};
 return {...f,deletion:state,body,remove:()=>f.client.withCommandEvents(body,()=>undefined,null)};
}
test('deletion drains a held original save-status read and version probe before its command',async()=>{
 const before=snapshot(),f=deletionReadFixture(),entered=deferred(),gate=deferred();let reading,deleting;
 try{
  await f.client.loadDocument(f.document);f.calls.length=0;const transport=f.client.session.transport;
  f.client.session.transport=async(path,init)=>{if(path.includes('/save-status')){entered.resolve();await gate.promise;}if(init?.method==='HEAD')assert.equal(f.deletion.commands.length,0,'Version probe completes before deletion');return transport(path,init);};
  reading=f.client.loadDocument(f.document);await entered.promise;deleting=f.remove();await flush();
  assert.equal(f.deletion.commands.length,0);assert.equal(f.client.view.document,f.document);
  const issued=f.calls.length;await f.client.loadDocument(f.document);await f.client.historyPage('history');assert.equal(f.calls.length,issued,'No new matching model or page reads while deletion drains');
  gate.resolve();await reading;await deleting;
  assert.equal(f.deletion.commands.length,1);assert.deepEqual(f.deletion.commands[0],f.body);assert.equal(f.calls.filter(path=>path==='/api/v1/documents/d').length,1,'The original version probe remains required before dispatch');
  assert.equal(f.client.view.document,null);assert.equal(f.client.viewReads.ownership.activeReads,0);
 }finally{gate.resolve();await Promise.allSettled([reading,deleting]);await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('deletion waits for an already-issued version HEAD to settle before dispatch',async()=>{
 const before=snapshot(),f=deletionReadFixture(),gate=deferred(),entered=deferred();let reading,deleting;
 try{
  await f.client.loadDocument(f.document);const transport=f.client.session.transport;
  f.client.session.transport=async(path,init)=>{if(init?.method==='HEAD'){entered.resolve();await gate.promise;}return transport(path,init);};
  reading=f.client.loadDocument(f.document);await entered.promise;deleting=f.remove();await flush();assert.equal(f.deletion.commands.length,0);assert.equal(f.client.viewReads.ownership.activeReads,1);
  gate.resolve();await Promise.all([reading,deleting]);assert.equal(f.deletion.commands.length,1);assert.equal(f.client.viewReads.ownership.activeReads,0);
 }finally{gate.resolve();await Promise.allSettled([reading,deleting]);await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('deletion waits through undo authority and its required version HEAD before dispatch',async()=>{
 const before=snapshot(),f=deletionReadFixture(),gate=deferred(),entered=deferred();let reading,deleting;
 try{
  await f.client.loadDocument(f.document);f.calls.length=0;const read=f.client.cache.read;
  f.client.cache.read=async(...args)=>{if(args[0]==='history'){entered.resolve();await gate.promise;}return read(...args);};const transport=f.client.session.transport;f.client.session.transport=async(path,init)=>{if(init?.method==='HEAD')assert.equal(f.deletion.commands.length,0);return transport(path,init);};
  reading=f.client.loadDocument(f.document);await entered.promise;deleting=f.remove();await flush();assert.equal(f.deletion.commands.length,0);
  gate.resolve();await Promise.all([reading,deleting]);assert.equal(f.calls.filter(path=>path==='/api/v1/documents/d').length,1);assert.equal(f.deletion.commands.length,1);
 }finally{gate.resolve();await Promise.allSettled([reading,deleting]);await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
for(const kind of ['history','checkpoints'])test('deletion drains an older '+kind+' page and version probe before dispatch',async()=>{
 const before=snapshot(),f=deletionReadFixture(),gate=deferred(),entered=deferred();let reading,deleting;
 try{
  await f.client.loadDocument(f.document);f.calls.length=0;const transport=f.client.session.transport;
  f.client.session.transport=async(path,init)=>{if(path.includes('/'+kind)){entered.resolve();await gate.promise;}if(init?.method==='HEAD')assert.equal(f.deletion.commands.length,0);return transport(path,init);};
  reading=f.client.historyPage(kind);await entered.promise;deleting=f.remove();await flush();assert.equal(f.deletion.commands.length,0);
  gate.resolve();await Promise.all([reading,deleting]);assert.equal(f.calls.filter(path=>path==='/api/v1/documents/d').length,1);assert.equal(f.deletion.commands.length,1);
 }finally{gate.resolve();await Promise.allSettled([reading,deleting]);await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('deletion blocks checkpoint navigation and retains all current roots until acknowledgement',async()=>{
 const before=snapshot(),f=deletionReadFixture();let pause;
 try{await f.client.loadDocument(f.document);const view=f.client.view,roots=f.client.viewModels.ownership.currentRoots;pause=f.client.pauseDocumentReads('d','1');await pause.drain;
  await assert.rejects(f.client.openCheckpoint(f.state.checkpoints.items[0]),/DOCUMENT_CHANGED/);assert.equal(f.deletion.commands.length,0);assert.equal(f.client.view,view);assert.equal(f.client.viewModels.ownership.currentRoots,roots);
 }finally{pause?.release();await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('predispatch deletion refusal resumes only its current document reads and retains the failure',async()=>{
 const before=snapshot(),f=deletionReadFixture();
 try{await f.client.loadDocument(f.document);const failure=Error('DELETE_REFUSED');f.client.ownedCommand=async()=>{throw failure;};
  await assert.rejects(f.remove(),error=>error===failure);assert.equal(f.client.documentReadBlocked('d'),false);assert.equal(f.deletion.refreshes,1);const count=f.calls.length;await f.client.loadDocument(f.document);assert(f.calls.length>count);assert.equal(f.client.view.document,f.document);
 }finally{await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('accepted deletion remains fenced if exact acknowledgement precedes projection retirement',async()=>{
 const before=snapshot(),f=deletionReadFixture();
 try{await f.client.loadDocument(f.document);f.client.ownedCommand=async()=>cloneOwnedModel('delete-test-events',[{type:'DocumentDeleted',payload:{id:'d'}}]);await f.remove();
  assert.equal(f.client.documentReadBlocked('d'),true);const calls=f.calls.length;await f.client.loadDocument(f.document);assert.equal(f.calls.length,calls);assert.equal(f.deletion.refreshes,0);
  f.client.patch({document:null,image:null,history:[],checkpoints:[],save:null});assert.equal(f.client.documentReadBlocked('d'),false);
 }finally{await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('an unrelated deletion event cannot latch the active document read barrier',async()=>{
 const before=snapshot(),f=deletionReadFixture();
 try{f.client.ownedCommand=async()=>cloneOwnedModel('delete-test-events',[{type:'DocumentDeleted',payload:{id:'other'}}]);await f.remove();assert.equal(f.client.documentReadBlocked('d'),false);assert.equal(f.deletion.refreshes,1);
 }finally{await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
for(const change of ['disconnect','identity','document-generation','draft-owner'])test('deletion waiting on view reads refuses changed '+change+' without dispatch or successor refresh',async()=>{
 const before=snapshot(),f=deletionReadFixture(),gate=deferred();let reading,deleting,oldOwner;
 try{
  reading=f.client.viewReads.run(async()=>{await gate.promise;});deleting=f.remove();const refused=assert.rejects(deleting,/AbortError|original command owner changed|DOCUMENT_OBSERVATION_OWNER_CHANGED/);await flush();assert.equal(f.deletion.commands.length,0);
  if(change==='disconnect')f.client.disconnect();else if(change==='identity')f.deletion.identity='replacement';else if(change==='document-generation')f.client.documentLifetime++;else{oldOwner=f.client.draftOwner;f.client.draftOwner={};}
  gate.resolve();await reading;await refused;assert.equal(f.deletion.commands.length,0);assert.equal(f.deletion.refreshes,0);assert.equal(f.client.documentReadBlocked('d'),false);
 }finally{if(change==='draft-owner')f.client.draftOwner=oldOwner;gate.resolve();await Promise.allSettled([reading,deleting]);await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('an old deletion lease cannot release a replacement owner barrier',async()=>{
 const before=snapshot(),f=deletionReadFixture();let old,current;
 try{old=f.client.pauseDocumentReads('d','1');await old.drain;f.client.documentLifetime++;current=f.client.pauseDocumentReads('d','1');await current.drain;old.release();assert.equal(f.client.documentReadBlocked('d'),true);assert.equal(f.deletion.refreshes,0);current.release();assert.equal(f.client.documentReadBlocked('d'),false);assert.equal(f.deletion.refreshes,1);
 }finally{old?.release();current?.release();await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('a concurrent second deletion cannot release the first document read barrier',async()=>{
 const before=snapshot(),f=deletionReadFixture(),gate=deferred();let reading,deleting;
 try{reading=f.client.viewReads.run(()=>gate.promise);deleting=f.remove();await flush();await assert.rejects(f.remove(),/DOCUMENT_OBSERVATION_OWNER_CHANGED/);assert.equal(f.client.documentReadBlocked('d'),true);assert.equal(f.deletion.commands.length,0);gate.resolve();await Promise.all([reading,deleting]);assert.equal(f.deletion.commands.length,1);
 }finally{gate.resolve();await Promise.allSettled([reading,deleting]);await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('retained reader cleanup failure prevents deletion without releasing its real lease',async()=>{
 const before=snapshot(),f=deletionReadFixture(),lease=allocationLedger.reserve({owner:'delete-read-cleanup-test',kind:'control',cpuBytes:10});let fail=true;
 const failure=new PromptReaderCleanupError([Error('unlock')],{response:{},reader:{releaseLock(){if(fail)throw Error('unlock');}},lease},false);
 try{await assert.rejects(f.client.viewReads.run(async()=>{throw failure;}),error=>error===failure);await assert.rejects(f.remove(),/VIEW_MODEL_READ_CLEANUP_FAILED/);assert.equal(f.deletion.commands.length,0);assert.equal(f.client.viewReads.ownership.cleanupFailures,1);assert(snapshot().cpuBytes>=before.cpuBytes+10);
 }finally{fail=false;await f.client.viewReads.release();await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('ordinary commands keep their existing path while a document read is outstanding',async()=>{
 const before=snapshot(),f=deletionReadFixture(),gate=deferred();let reading;
 try{reading=f.client.viewReads.run(()=>gate.promise);let sent=false;f.client.ownedCommand=async()=>{sent=true;return cloneOwnedModel('delete-test-events',[]);};await f.client.withCommandEvents({type:'SaveCheckpoint',name:'Retained'},()=>undefined);assert(sent);assert.equal(f.client.viewReads.ownership.activeReads,1);assert.equal(f.client.documentReadBlocked('d'),false);
 }finally{gate.resolve();await reading;await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});

function retainedDeletionCommandFixture(){
 const f=deletionReadFixture(),records=new Map(),requests=[];
 f.client.journal={async put(key,value){records.set(key,value);},async get(key){return records.get(key);},close(){}};
 f.client.restorePending=async()=>{};f.client.ownedCommand=EditorClient.prototype.ownedCommand;
 const original=f.client.session.transport,state={phase:'lost-response',committed:false,command:null};
 f.client.session.transport=async(path,init)=>{
  requests.push({path,method:init?.method??'GET'});
  if(path==='/api/v1/commands'&&init?.method==='POST'){
   const command=JSON.parse(init.body).command;state.command=command;
   if(state.phase==='lost-response'){state.committed=true;throw state.failure;}
   return response({protocolVersion:1,kind:'receipt',receipt:{commandId:command.commandId,status:'accepted',transactionId:command.transactionId,fromSeq:'1',toSeq:'1',documentRevision:null}});
  }
  if(path==='/api/v1/commands/'+state.command?.commandId&&state.phase==='rejected')return response({protocolVersion:1,kind:'receipt',receipt:{commandId:state.command.commandId,status:'rejected',code:'STALE_REVISION',currentRevision:'2',details:{hash:'sha256:'+'0'.repeat(64),byteLength:'0',mediaType:'application/json'}}});
  if(path==='/api/v1/commands/'+state.command?.commandId+'/result')return response({protocolVersion:1,kind:'unknown'});
  if(init?.method==='HEAD'&&state.committed)return new Response(null,{status:404});
  return original(path,init);
 };
 return {...f,records,requests,delivery:state};
}
test('a committed deletion with a lost original response keeps detailed reads fenced and retains its original error',async()=>{
 const before=snapshot(),f=retainedDeletionCommandFixture();
 try{
  await f.client.loadDocument(f.document);f.requests.length=0;const failure=new TypeError('Failed to fetch after commit');f.delivery.failure=failure;
  await assert.rejects(f.remove(),error=>error===failure);
  assert(f.delivery.committed);assert.equal(f.records.size,1);const [record]=f.records.values();assert.equal(record.request.command.commandId,f.delivery.command.commandId);assert.equal(record.result,undefined,'No invented receipt or rejection');
  assert.equal(f.client.view.document,f.document,'The stale projection cannot prove deletion did not commit');assert.equal(f.client.documentReadBlocked('d'),true);assert.equal(f.deletion.refreshes,0);
  const count=f.requests.length;await f.client.loadDocument(f.document);await f.client.historyPage('history');assert.equal(f.requests.length,count,'No post-failure document HEAD can reach the deleted server');
  assert.deepEqual(f.requests.map(row=>row.method),['POST']);
 }finally{await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('accepted receipt with failed event and recovery proofs keeps the journalled deletion fenced',async()=>{
 const before=snapshot(),f=retainedDeletionCommandFixture();
 try{
  await f.client.loadDocument(f.document);f.requests.length=0;f.delivery.phase='proof-failure';f.delivery.committed=true;const recoveryFailure=Error('RECOVERY_PROOF_UNAVAILABLE');f.client.sync=async()=>{throw recoveryFailure;};
  await assert.rejects(f.remove(),error=>error instanceof AggregateError&&error.message==='COMMAND_RESULT_PROOF_FAILED'&&error.errors.includes(recoveryFailure));
  const [record]=f.records.values();assert.equal(record.result.kind,'receipt');assert.equal(record.result.receipt.status,'accepted');assert.equal(f.client.view.document,f.document);assert.equal(f.client.documentReadBlocked('d'),true);assert.equal(f.deletion.refreshes,0);
  const count=f.requests.length;await f.client.loadDocument(f.document);await f.client.historyPage('checkpoints');assert.equal(f.requests.length,count);assert.equal(f.requests.filter(row=>row.method==='POST').length,1);
 }finally{await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('later exact rejected-receipt lookup releases its own uncertain deletion without replaying the POST',async()=>{
 const before=snapshot(),f=retainedDeletionCommandFixture();
 try{
  f.delivery.failure=Error('Original delivery unknown');await assert.rejects(f.remove(),error=>error===f.delivery.failure);assert.equal(f.client.documentReadBlocked('d'),true);
  // This branch represents a genuinely rejected original command: the lookup
  // carries its exact identity and the real deliverOwned validator consumes it.
  f.delivery.committed=false;f.delivery.phase='rejected';await assert.rejects(f.client.ownedRetry(f.delivery.command.commandId),/STALE_REVISION/);
  assert.equal(f.client.documentReadBlocked('d'),false);assert.equal(f.deletion.refreshes,1);assert.equal(f.records.get('command:'+f.delivery.command.commandId).result.receipt.status,'rejected');
  assert.deepEqual(f.requests.map(row=>row.method),['POST','GET']);const count=f.requests.length;await f.client.loadDocument(f.document);assert(f.requests.length>count);
 }finally{await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('rejection of an older command cannot release a replacement deletion barrier',async()=>{
 const before=snapshot(),f=retainedDeletionCommandFixture();let replacement;
 try{
  f.delivery.failure=Error('Original delivery unknown');await assert.rejects(f.remove(),error=>error===f.delivery.failure);f.client.documentLifetime++;replacement=f.client.pauseDocumentReads('d','1');await replacement.drain;replacement.journaled('replacement-command');
  f.delivery.committed=false;f.delivery.phase='rejected';await assert.rejects(f.client.ownedRetry(f.delivery.command.commandId),/STALE_REVISION/);
  assert.equal(f.client.documentReadBlocked('d'),true);assert.equal(f.deletion.refreshes,0);assert.equal(f.client.documentReadBarrier.commandId,'replacement-command');
 }finally{f.client.documentLifetime++;replacement?.release();await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});

function retainedDeletionCloseOwner(f){
 const checkpoint={protocolVersion:1,sessionId:'barrier-ui',uiSeq:'1',preferences:{documentId:'d',selectedLayerIds:[]},drafts:[]},uiRequests=[],transport=f.client.session.transport;
 f.client.session.csrf=()=> 'fixture-csrf';
 f.client.session.transport=async(path,init)=>{
  if(path!=='/api/v1/ui/barrier-ui')return transport(path,init);
  uiRequests.push({method:init?.method??'GET'});
  if(init?.method==='POST'){const request=JSON.parse(init.body);assert.equal(request.body.type,'SetPreferences');assert.equal(request.body.preferences.documentId,null);return response({protocolVersion:1,requestId:request.requestId,status:'accepted',uiSeq:'2'});}
  return response(checkpoint);
 };
 const owner=new DraftPersistence('barrier-ui',f.client.session.transport,f.client.session.csrf);
 owner.checkpoint=checkpoint;owner.drafts.set('saved',{id:'saved',kind:'prompt',documentId:'d',targetLayerId:null,expectedDocumentRevision:'1',generation:'1',composing:false,text:'Saved draft retained through uncertain deletion',savedGeneration:'1',pending:false,error:null});
 f.client.draftOwner=owner;f.client.ui=owner.checkpoint;
 return {owner,uiRequests};
}
test('actual closeDocument retires an unknown deletion barrier after saved-owner closure without a later blocked read',async()=>{
 const before=snapshot(),f=retainedDeletionCommandFixture(),{owner,uiRequests}=retainedDeletionCloseOwner(f);
 try{
  f.delivery.failure=Error('Deletion response lost');await assert.rejects(f.remove(),error=>error===f.delivery.failure);
  const barrier=f.client.documentReadBarrier;assert(barrier?.hold);assert.equal(f.client.controlReads.ownership.controlReads,0,'Original command has already rejected');
  await f.client.closeDocument();
  assert.equal(f.client.view.document,null);assert.equal(f.client.documentReadBarrier,undefined,'Retirement must occur inside the real publication path');
  assert.equal(owner.drafts.size,0);assert.equal(f.client.documentResources.snapshot.releases,1);assert.deepEqual(uiRequests.map(row=>row.method),['GET','POST']);
  assert.equal(f.requests.filter(row=>row.method==='HEAD').length,0);assert.equal(f.records.get('command:'+f.delivery.command.commandId).result,undefined,'Closing does not invent a deletion receipt');
 }finally{await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
for(const deleted of [false,true])test('actual recovered document-list refresh '+(deleted?'retires':'preserves')+' the unknown deletion barrier for its published owner',async()=>{
 const before=snapshot(),f=retainedDeletionCommandFixture();
 try{
  f.delivery.failure=Error('Deletion response lost');await assert.rejects(f.remove(),error=>error===f.delivery.failure);const barrier=f.client.documentReadBarrier;assert(barrier?.hold);
  f.client.cache.published=async()=>({generation:'after-deletion',cursor:'2',epoch:'1'});
  f.client.cache.rows=async function*(generation,type){assert.equal(generation,'after-deletion');assert.equal(type,'document');if(!deleted)yield {value:f.document};};
  await EditorClient.prototype.refresh.call(f.client);
  assert.equal(f.client.documentReadBarrier,deleted?undefined:barrier,'Inspect stored ownership directly without invoking lazy read admission');
  assert.equal(f.client.view.document,deleted?null:f.document);assert.equal(f.client.view.documents.length,deleted?0:1);
  assert.deepEqual(f.requests.map(row=>row.method),['POST'],'Authoritative list publication needs no detailed HEAD against the uncertain document');
  assert.equal(f.records.get('command:'+f.delivery.command.commandId).result,undefined);
 }finally{await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});
test('failed recovered-view publication retains the unknown barrier and original selected owner',async()=>{
 const before=snapshot(),f=retainedDeletionCommandFixture();let restore;
 try{
  f.delivery.failure=Error('Deletion response lost');await assert.rejects(f.remove(),error=>error===f.delivery.failure);const barrier=f.client.documentReadBarrier;
  f.client.cache.published=async()=>({generation:'after-deletion',cursor:'2',epoch:'1'});f.client.cache.rows=async function*(){};
  const publish=f.client.state.set.bind(f.client.state),failure=Error('Publication refused');restore=()=>{f.client.state.set=publish;};f.client.state.set=value=>{if(value.document===null)throw failure;publish(value);};
  await assert.rejects(EditorClient.prototype.refresh.call(f.client),error=>error===failure);
  assert.equal(f.client.documentReadBarrier,barrier);assert.equal(f.client.view.document,f.document);assert.equal(f.client.viewReads.ownership.activeReads,0);
 }finally{restore?.();await f.close();}assert.equal(snapshot().cpuBytes,before.cpuBytes);
});

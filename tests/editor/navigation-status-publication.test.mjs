// Actual EditorClient methods, model owners and command/event validators. IO is
// supplied by explicit gates. These controller tests do not qualify browser
// paint, native memory, physical timing, or the observation verifier itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {transformWithOxc} from 'vite';
import {allocationsURL,promptMemoryURL} from '../owned-preview-module.mjs';
import {viewModelDependencies} from '../view-model-module.mjs';
import {draftStateDependencies} from '../draft-state-module.mjs';

const root=process.env.NAVIGATION_CLIENT_SOURCE_ROOT??'.';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function moduleURL(path,imports={}){
 let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;
 for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
 return data(code);
}
const {viewURL,memoryURL,controlURL}=await viewModelDependencies(allocationsURL,{promptURL:promptMemoryURL});
const {draftURL}=await draftStateDependencies(allocationsURL,{root,memoryURL,controlURL,promptURL:promptMemoryURL});
const {DraftPersistence}=await import(draftURL);
const jsonURL=await moduleURL('src/protocol/json.ts'),shaURL=await moduleURL('src/protocol/sha256.ts');
const validatorURL=pathToFileURL(resolve('dist/local/src/protocol/validate.js')).href;
const commandsURL=await moduleURL('src/state/command-results.ts',{'../observability/allocations.js':allocationsURL,'../observability/model-memory.js':memoryURL,'../observability/prompt-memory.js':promptMemoryURL,'./control-memory.js':controlURL,'../protocol/json.js':jsonURL,'../protocol/sha256.js':shaURL,'../protocol/validate.js':validatorURL});
const resourcesURL=await moduleURL('src/state/document-lifecycle.ts');
const historyURL=await moduleURL('src/state/history-availability.ts',{'../observability/model-memory.js':memoryURL});
const documentsURL=await moduleURL(root+'/src/state/document-list.ts',{'../observability/model-memory.js':memoryURL});
const source=(await transformWithOxc(await readFile(root+'/src/state/editor-client.ts','utf8'),'editor-client.ts')).code.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];?\n/gm,'');
const {allocationLedger}=await import(allocationsURL),{cloneOwnedModel}=await import(memoryURL);
const totals=()=>{const s=allocationLedger.snapshot();return {cpu:s.cpuBytes,handles:s.handles,records:s.activeRecords};};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const response=value=>{const bytes=JSON.stringify(value);return new Response(bytes,{headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(bytes))}});};
let serial=0;

async function fixture(t){
 const calls=[],gates=[],tasks=[],ownedResults=[],owners=[],storage=new Map(),boundary={calls,storage,published:null,onSet:null,cacheOpen:async()=>cache,journalOpen:async()=>journal};
 // Only host publication, recovery IO and session storage are substituted.
 // The observer records what it receives and the public state at that instant;
 // it never supplies or infers an authority result for the implementation.
 const module=await import(data(`
 import {ViewModelOwners,ViewModelReads,ownDownload,canonicalControlHash,VIEW_MODEL_LIMITS} from ${JSON.stringify(viewURL)};
 import {CommandControlReads,COMMAND_RESULT_LIMITS,readCommandEvents} from ${JSON.stringify(commandsURL)};
 import {DocumentResources} from ${JSON.stringify(resourcesURL)};
 import {collectOwnedDocuments} from ${JSON.stringify(documentsURL)};
 import {readUndoAvailability} from ${JSON.stringify(historyURL)};
 import {readOwnedJSON,createOwnedModel,cloneOwnedModel,modelPayloadBytes,reserveModelBytes,ModelPayload} from ${JSON.stringify(memoryURL)};
 import {reserveCommandWire,measureControl} from ${JSON.stringify(controlURL)};
 import {allocationLedger} from ${JSON.stringify(allocationsURL)};
 import {canonical,parseControlJSON} from ${JSON.stringify(jsonURL)};
 import {SHA256} from ${JSON.stringify(shaURL)};
 import {event as validateEvent} from ${JSON.stringify(validatorURL)};
 let boundary;
 export function bind(value){boundary=value;}
 const createValueModel=initial=>{let value=initial;return {value:{get:()=>value},set(next){boundary.onSet?.(next);value=next;boundary.published=next;boundary.calls.push({type:'published',view:next});}};};
 const EMPTY_EXPECTED_VERSIONS={hash:'sha256:10584db4c85cf1d5cbd2eda3429934a693b7c26268e63be96dbdb23d6dd42069',byteLength:'33',mediaType:'application/json'};
 const browserPhases={reset(){},resetNavigation(){},invalidateNavigationStatus(){boundary.calls.push({type:'invalid'});},
  recordNavigationStatus(input){boundary.calls.push({type:'state',input:{...input},published:boundary.published});},
  recordNavigationAuthority(input){boundary.calls.push({type:'authority',input:{...input},published:boundary.published});},
  recordNavigationModelReady(input){boundary.calls.push({type:'model-ready',input:{...input},published:boundary.published});},
  recorder:{start(name,context){const row={type:'phase',name,context:{...context}};boundary.calls.push(row);return {end(outcome,extra){row.outcome=outcome;Object.assign(row.context,extra);}};}}};
 class RecoveryCache {static open(...args){return boundary.cacheOpen(...args);}}
 class BrowserJournal {static open(...args){return boundary.journalOpen(...args);}}
 class RecoveryConsumer {cancel(){}async release(){}}
 class RecoveryPublicationConflict extends Error{}
 class DraftPersistence {constructor(){throw Error('Unexpected draft owner construction');}}
 const sessionStorage={getItem:key=>boundary.storage.get(key)??null,setItem:(key,value)=>boundary.storage.set(key,value)};
 ${source}
 // Independent observer boundary for fixture ${++serial}.
 `));
 module.bind(boundary);
 const before=totals(),document={id:'document_1',revision:'4',historyHead:'history_4',orderedLayerIds:['layer_1'],image:null};
 const image={schemaVersion:1,width:512,height:512,layers:[]},load={gate:null,failure:null,version:'4'};
 let identity='client_1',cursor='40',transport=async(path,init)=>{
  const prefix='/api/v1/documents/'+document.id;
  if(path===prefix&&init?.method==='HEAD')return new Response(null,{headers:{'X-App-Entity-Version':load.version}});
  if(path===prefix+'/image'){calls.push({type:'image-read'});await load.gate?.promise;if(load.failure)throw load.failure;return response(image);}
  if(path===prefix+'/history'||path===prefix+'/checkpoints')return response({items:[],next:null});
  if(path===prefix+'/save-status?sessionId=ui_fixture')return response({pendingCommandCount:0,draftDirty:false,documentChangedSinceCheckpoint:false,bundleOutdated:false});
  throw Error('Unexpected transport '+path);
 };
 const cache={published:async()=>({cursor,generation:'snapshot_1'}),async *rows(generation,type){assert.equal(generation,'snapshot_1');assert.equal(type,'document');yield {value:structuredClone(document)};},read:async(kind,id)=>kind==='document'&&id===document.id?structuredClone(document):undefined,close(){calls.push({type:'cache-close'});}};
 const journal={rows:new Map(),async put(key,value){this.rows.set(key,structuredClone(value));calls.push({type:'journal',key,value:structuredClone(value)});},close(){calls.push({type:'journal-close'});}};
 const client=new module.EditorClient({identity:()=>identity,csrf:()=> 'csrf',transport:(...args)=>transport(...args)});
 const makeOwner=()=>{
  const checkpoint={sessionId:'ui_fixture',uiSeq:'1',preferences:{documentId:null,selectedLayerIds:['layer_1','absent']},drafts:[]},model=cloneOwnedModel('navigation-test-ui-checkpoint',checkpoint);let disposed=false;
  const owner={sessionId:checkpoint.sessionId,checkpoint:model.value,restore:async()=>{},release:async()=>{},pendingRequests:()=>[],borrowCheckpoint(value){assert.equal(value,model.value);const release=model.pin();return {value,release};},async dispose(){if(!disposed){disposed=true;model.release();}}};owners.push(owner);return owner;
 };
 client.owner=identity;client.lifecycle=3;client.documentLifetime=7;client.draftOwner=makeOwner();client.ui=client.draftOwner.checkpoint;client.cache=cache;client.journal=journal;
 storage.set('ie-ui-session:'+identity,client.sessionId);
 client.preferences=async()=>{};client.restorePending=async()=>{};client.startStream=()=>calls.push({type:'stream'});client.sync=async()=>{};client.draftStatus=()=> 'Drafts saved locally';
 const gate=()=>{const value=deferred();gates.push(value);return value;};
 const track=promise=>{tasks.push(promise);void promise.then(value=>{if(typeof value?.release==='function')ownedResults.push(value);},()=>{});return promise;};
 let cleaned=false;
 const close=async()=>{
  if(cleaned)return;cleaned=true;boundary.onSet=null;for(const gate of gates)gate.resolve();await Promise.allSettled(tasks);for(const result of ownedResults)result.release();
  await client.dispose();for(const owner of owners)await owner.dispose();assert.deepEqual(totals(),before);
 };
 t.after(close);
 // Install the real collected list owner before Open; a raw array cannot
 // supply the row ownership required at the image publication boundary.
 await client.refresh();const ownedDocument=client.view.documents[0];
 assert.notEqual(ownedDocument,document);assert.deepEqual(ownedDocument,document);
 const [rendered]=client.renderViewModels(ownedDocument);assert.equal(rendered.value,client.view.documents);const unpin=rendered.pin();unpin();
 client.patch({ready:true,message:'Local recovery complete. Accepted edits are saved locally.',cursor});
 return {client,document:ownedDocument,image,load,cache,journal,calls,boundary,gate,track,close,makeOwner,
  states:()=>calls.filter(row=>row.type==='state'),authority:kind=>calls.filter(row=>row.type==='authority'&&(!kind||row.input.kind===kind)),
  installDraftOwner(transport){const owner=new DraftPersistence('ui_fixture',transport,()=> 'csrf');owner.checkpoint=client.draftOwner.checkpoint;owners.push(owner);client.draftOwner=owner;client.ui=owner.checkpoint;return owner;},
  setIdentity(value){identity=value;},setCursor(value){cursor=value;},setTransport(value){transport=value;}};
}

test('central status observation follows the real publication and keeps independent client identities',async t=>{
 const f=await fixture(t);f.calls.length=0;f.client.patch({message:'Exact published status',ready:false,busy:true,error:'retained error',recovery:'retained recovery'});
 const row=f.states().at(-1);assert.equal(row.published,f.client.view);assert.equal(row.input.message,f.client.view.message);
 assert.deepEqual({...row.input,sourceId:null},{sourceId:null,lifecycle:3,documentGeneration:7,sessionId:'ui_fixture',documentId:null,revision:null,cursor:'40',message:'Exact published status',ready:false,busy:true,hasError:true,hasRecovery:true});
 assert.match(row.input.sourceId,/^[0-9a-f-]{36}$/);assert.equal(f.calls[0].type,'published');assert.equal(f.calls[1].type,'state');
 const other=await fixture(t);assert.notEqual(other.states().at(-1).input.sourceId,row.input.sourceId);await other.close();
});

test('a failed real setter preserves the prior view and invalidates status instead of reporting success',async t=>{
 const f=await fixture(t),prior=f.client.view,failure=Error('host setter failed');f.calls.length=0;f.boundary.onSet=()=>{throw failure;};
 assert.throws(()=>f.client.patch({message:'Must not publish'}),error=>error===failure);assert.equal(f.client.view,prior);assert.deepEqual(f.states(),[]);assert.equal(f.calls.filter(row=>row.type==='invalid').length,1);
 f.boundary.onSet=null;f.client.patch({message:'Publication retry'});assert.equal(f.states().at(-1).input.message,'Publication retry');
});

test('reentrant native publication invalidates observation history while retaining actual final state',async t=>{
 const f=await fixture(t);f.calls.length=0;let entered=false;
 f.boundary.onSet=()=>{if(!entered){entered=true;f.client.patch({message:'Reentrant state'});}};
 f.client.patch({message:'Outer state'});f.boundary.onSet=null;
 assert(f.calls.some(row=>row.type==='invalid'));assert.equal(f.client.view.message,'Outer state');assert.equal(f.states().at(-1).published,f.client.view);
});

test('terminal disposal goes through the same status publication boundary',async t=>{
 const f=await fixture(t);f.calls.length=0;await f.client.dispose();
 const last=f.states().at(-1);assert.equal(last.published,f.client.view);assert.equal(last.input.message,'');assert.equal(last.input.ready,false);assert.equal(last.input.documentId,null);assert.equal(last.input.revision,null);assert.equal(last.input.cursor,'0');assert.equal(f.authority().length,0);
});

test('Open waits for model load and durable preferences before authority and the terminal message',async t=>{
 const f=await fixture(t),load=f.gate(),preferences=f.gate();let saving=false;
 f.load.gate=load;f.client.preferences=async value=>{saving=true;assert.deepEqual(value,{documentId:f.document.id,selectedLayerIds:[]});await preferences.promise;};
 const opening=f.track(f.client.open(f.document.id));await turn();assert.equal(saving,false);assert.equal(f.authority('opened').length,0);assert.notEqual(f.client.view.message,'Local document opened.');
 load.resolve();await turn();assert.equal(saving,true);assert.deepEqual(f.client.view.image,f.image);assert.equal(f.authority('opened').length,0);assert.notEqual(f.client.view.message,'Local document opened.');
 preferences.resolve();await opening;
 const authority=f.authority('opened');assert.equal(authority.length,1);assert.equal(authority[0].input.documentId,f.document.id);assert.equal(authority[0].input.documentGeneration,8);assert.equal(authority[0].input.revision,'4');
 assert.equal(f.client.view.message,'Local document opened.');assert(f.calls.indexOf(authority[0])<f.calls.indexOf(f.states().at(-1)));
});

for(const stage of ['load','preferences'])test('Open '+stage+' rejection cannot publish completion',async t=>{
 const f=await fixture(t),failure=Error(stage+' refused'),prior=f.client.view.message;
 if(stage==='load')f.load.failure=failure;else f.client.preferences=async()=>{throw failure;};
 await assert.rejects(f.client.open(f.document.id),error=>error===failure||error instanceof AggregateError&&error.errors.includes(failure));assert.equal(f.client.view.message,prior);assert.equal(f.authority('opened').length,0);assert.equal(f.states().some(row=>row.input.message==='Local document opened.'),false);
});

const invalidateOpen={
 lifecycle:f=>{f.client.lifecycle++;},draftOwner:f=>{f.client.draftOwner=f.makeOwner();},documentGeneration:f=>{f.client.documentLifetime++;},
 documentId:f=>f.client.patch({document:{...f.document,id:'document_other'}}),sessionObject:f=>{f.client.session={...f.client.session};},sessionIdentity:f=>f.setIdentity('client_other'),
};
for(const [kind,invalidate]of Object.entries(invalidateOpen))test('Open refuses late completion after '+kind+' changes during preferences',async t=>{
 const f=await fixture(t),preferences=f.gate();let entered=false;f.client.preferences=()=>{entered=true;return preferences.promise;};
 const opening=f.track(f.client.open(f.document.id));await turn();assert.equal(entered,true);assert.deepEqual(f.client.view.image,f.image);invalidate(f);preferences.resolve();await opening;
 assert.equal(f.authority('opened').length,0);assert.equal(f.states().some(row=>row.input.message==='Local document opened.'),false);
});

test('automatic Open preserves the recovery status and restores only valid selection without opened authority',async t=>{
 const f=await fixture(t),prior=f.client.view.message;let persisted=false;f.client.preferences=async()=>{persisted=true;};
 await f.client.open(f.document.id,false);assert.equal(persisted,false);assert.equal(f.client.view.message,prior);assert.deepEqual(f.client.view.selected,['layer_1']);assert.equal(f.authority('opened').length,0);
});

test('a superseded live document revision leaves no published image and cannot qualify Open',async t=>{
 const f=await fixture(t),prior=f.client.view.message;f.load.version='5';await f.client.open(f.document.id);
 assert.equal(f.client.view.image,null);assert.equal(f.client.view.message,prior);assert.equal(f.authority('opened').length,0);
});

function recoveryGate(f){
 f.client.patch({documents:[],ready:false});const final=f.gate();let waiting=false;
 f.client.listUI=async()=>{};f.client.listStages=async()=>{};f.client.discoverPending=async()=>{};
 f.client.listPending=async()=>{waiting=true;await final.promise;};
 return {final,get waiting(){return waiting;}};
}
test('connect recovery authority follows every inventory and the captured connection owner',async t=>{
 const f=await fixture(t),gate=recoveryGate(f),task=f.track(f.client.connect());await turn();assert.equal(gate.waiting,true);assert.equal(f.client.view.ready,false);assert.equal(f.authority('recovered').length,0);
 gate.final.resolve();await task;assert.equal(f.client.view.ready,true);assert.equal(f.authority('recovered').length,1);assert.equal(f.client.view.message,'Local recovery complete. Accepted edits are saved locally.');
 const authority=f.authority('recovered')[0],published=f.states().findLast(row=>row.input.ready);assert(f.calls.indexOf(authority)<f.calls.indexOf(published));assert.equal(authority.input.lifecycle,f.client.lifecycle);
});
for(const kind of ['draftOwner','sessionIdentity','lifecycle'])test('connect cannot publish recovered status for a changed '+kind,async t=>{
 const f=await fixture(t),gate=recoveryGate(f),task=f.track(f.client.connect());await turn();assert.equal(gate.waiting,true);invalidateOpen[kind](f);gate.final.resolve();await task;
 assert.equal(f.client.view.ready,false);assert.equal(f.authority('recovered').length,0);assert.equal(f.client.view.message,'Recovering complete local transactions…');
});

function checkpointIO(f,{rejected=false,changeReceipt,restoreDrafts=true}={}){
 const receiptGate=f.gate(),eventsGate=f.gate(),projectionGate=f.gate(),draftGate=f.gate(),paths=[];
 let submitted,receipt,event,projectionStarted=false,eventsStarted=false,draftStarted=false;
 const recovery={recoveryId:'recovery_1',writerEpoch:'1',projectionSchema:19,highWater:'41',expiresAt:'2099-01-01T00:00:00.000Z'};
 f.client.patch({document:f.document,message:'SaveCheckpoint…',busy:true});
 f.setTransport(async(path,init)=>{
  paths.push(path);
  if(path==='/api/v1/commands'&&init?.method==='POST'){
   submitted=JSON.parse(init.body).command;
   receipt=rejected?{status:'rejected',commandId:submitted.commandId,code:'STALE_REVISION'}:{status:'accepted',commandId:submitted.commandId,transactionId:submitted.transactionId,fromSeq:'41',toSeq:'41',documentRevision:'5'};
   changeReceipt?.(receipt,submitted);await receiptGate.promise;return response({protocolVersion:1,kind:'receipt',receipt});
  }
  if(path==='/api/v1/commands/'+receipt?.commandId+'/result'){
   eventsStarted=true;await eventsGate.promise;
   event={schemaVersion:1,payloadVersion:1,eventId:'event_41',workspaceSeq:'41',streamId:f.document.id,streamSeq:'5',documentId:f.document.id,resultingDocumentRevision:'5',commandId:receipt.commandId,correlationId:submitted.correlationId,causationId:null,transactionId:receipt.transactionId,writerEpoch:'1',recordedAt:'2026-10-01T00:00:00.000Z',type:'CheckpointSaved',payload:{checkpoint:{id:'checkpoint_1',name:submitted.body.name,documentId:f.document.id,documentRevision:'4',historyHead:'history_4',highWater:'40'}}};
   return response({protocolVersion:1,kind:'batches',recovery,nextCursor:'41',more:false,batches:[{kind:'inline',transactionId:receipt.transactionId,fromSeq:'41',toSeq:'41',events:[event]}]});
  }
  if(path==='/api/v1/events?after=41&recoveryId=recovery_1')return response({protocolVersion:1,kind:'batches',recovery,nextCursor:'41',more:false,batches:[]});
  if(path==='/api/v1/recovery/recovery_1/release')return new Response(null,{status:204});
  throw Error('Unexpected checkpoint path '+path);
 });
 f.client.sync=async()=>{projectionStarted=true;await projectionGate.promise;f.setCursor('41');f.client.patch({document:{...f.document,revision:'5'},cursor:'41'});};
 if(restoreDrafts)f.client.draftOwner.restore=f.client.draftOwner.restoreForCommand=async()=>{draftStarted=true;await draftGate.promise;};
 return {receiptGate,eventsGate,projectionGate,draftGate,paths,get submitted(){return submitted;},get receipt(){return receipt;},get event(){return event;},get projectionStarted(){return projectionStarted;},get eventsStarted(){return eventsStarted;},get draftStarted(){return draftStarted;}};
}

for(const method of ['command','ownedCommand'])test(method+' checkpoint authority waits for the exact receipt, validated complete events, projection and draft restore',async t=>{
 const f=await fixture(t),io=checkpointIO(f),body={type:'SaveCheckpoint',name:'Original checkpoint'},task=f.track(f.client[method](body));let result;
 try{
  await turn();assert(io.submitted);body.name='Caller changed this later';assert.equal(f.authority('checkpoint').length,0);assert.equal(io.eventsStarted,false);
  const journaled=f.journal.rows.get('command:'+io.submitted.commandId);assert.deepEqual(journaled.request.command,io.submitted);assert.equal(io.submitted.body.name,'Original checkpoint');
  io.receiptGate.resolve();await turn();assert.equal(io.eventsStarted,true);assert.equal(io.projectionStarted,true);assert.equal(io.draftStarted,false);assert.equal(f.authority('checkpoint').length,0);
  io.eventsGate.resolve();await turn();assert(io.paths.includes('/api/v1/events?after=41&recoveryId=recovery_1'));assert(io.paths.includes('/api/v1/recovery/recovery_1/release'));assert.equal(io.draftStarted,false);assert.equal(f.authority('checkpoint').length,0);
  io.projectionGate.resolve();await turn();assert.equal(io.draftStarted,true);assert.equal(f.authority('checkpoint').length,0);assert.notEqual(f.client.view.message,'SaveCheckpoint accepted and saved locally.');
  io.draftGate.resolve();result=await task;
  const events=method==='ownedCommand'?result.value:result;assert.equal(events[0].type,'CheckpointSaved');assert.equal(events[0].payload.checkpoint.documentRevision,'4');
  const authority=f.authority('checkpoint');assert.equal(authority.length,1);assert.deepEqual(authority[0].input,{...f.client.navigationStatusContext(),kind:'checkpoint',commandId:io.submitted.commandId,transactionId:io.submitted.transactionId,fromSeq:'41',toSeq:'41'});
  assert.equal(f.client.view.message,'SaveCheckpoint accepted and saved locally.');assert(f.calls.indexOf(authority[0])<f.calls.indexOf(f.states().at(-1)));
 }finally{if(method==='ownedCommand')result?.release();}
});

for(const method of ['command','ownedCommand'])test(method+' rejected checkpoint has no completion authority or success message',async t=>{
 const f=await fixture(t),io=checkpointIO(f,{rejected:true}),task=f.track(f.client[method]({type:'SaveCheckpoint',name:'Refused'}));io.receiptGate.resolve();
 await assert.rejects(task,/STALE_REVISION/);assert.equal(f.authority('checkpoint').length,0);assert.equal(io.eventsStarted,false);assert.notEqual(f.client.view.message,'SaveCheckpoint accepted and saved locally.');
});

for(const mismatch of ['commandId','transactionId','documentId','revision','sessionId','clientId'])test('checkpoint authority rejects mismatched original '+mismatch,async t=>{
 const f=await fixture(t),command={body:{type:'SaveCheckpoint'},commandId:'original_command',transactionId:'original_transaction',documentId:f.document.id,sessionId:f.client.sessionId,clientId:f.client.session.identity()},receipt={status:'accepted',commandId:'original_command',transactionId:'original_transaction',documentRevision:'4',fromSeq:'41',toSeq:'41'};
 f.client.patch({document:f.document});
 f.client.recordNavigationCheckpoint(command,receipt);assert.equal(f.authority('checkpoint').length,1);f.calls.length=0;
 if(mismatch==='commandId'||mismatch==='transactionId')receipt[mismatch]='foreign_identity';else if(mismatch==='sessionId'||mismatch==='clientId')command[mismatch]='foreign_identity';else f.client.patch({document:{...f.document,[mismatch==='documentId'?'id':mismatch]:mismatch==='revision'?'9':'foreign_document'}});
 f.client.recordNavigationCheckpoint(command,receipt);assert.equal(f.authority('checkpoint').length,0);
});

for(const field of ['commandId','transactionId'])test('actual owned checkpoint delivery refuses a foreign '+field+' receipt before event recovery',async t=>{
 const f=await fixture(t),io=checkpointIO(f,{changeReceipt:receipt=>{receipt[field]='foreign_identity';}}),task=f.track(f.client.ownedCommand({type:'SaveCheckpoint',name:'Original'}));io.receiptGate.resolve();
 await assert.rejects(task,/RECEIPT_UNKNOWN/);assert.equal(io.eventsStarted,false);assert.equal(f.authority('checkpoint').length,0);assert.notEqual(f.client.view.message,'SaveCheckpoint accepted and saved locally.');
});


function heldCheckpointBody(f,checkpoint){
 const entered=f.gate(),resume=f.gate(),unlocked=f.gate(),bytes=new TextEncoder().encode(JSON.stringify(checkpoint));let reads=0,cancels=0,unlocks=0;
 const body=new ReadableStream({async pull(controller){entered.resolve();await resume.promise;controller.enqueue(bytes);controller.close();}},{highWaterMark:0}),native=body.getReader.bind(body);
 body.getReader=()=>{const reader=native();return {get closed(){return reader.closed;},read(){reads++;return reader.read();},cancel(){cancels++;return reader.cancel();},releaseLock(){reader.releaseLock();unlocks++;unlocked.resolve();}};};
 return {entered,resume,unlocked,body,response:new Response(body,{headers:{'content-type':'application/json','content-length':String(bytes.byteLength)}}),get reads(){return reads;},get cancels(){return cancels;},get unlocks(){return unlocks;}};
}

for(const method of ['command','ownedCommand'])test(method+' accepted checkpoint joins the newest real draft restore after its own response drains',async t=>{
 const f=await fixture(t),checkpoint=uiSeq=>({sessionId:'ui_fixture',uiSeq,preferences:{documentId:f.document.id,selectedLayerIds:['layer_1']},drafts:[]});
 const own=heldCheckpointBody(f,checkpoint('1')),newest=heldCheckpointBody(f,checkpoint('2')),draftCalls=[];
 const owner=f.installDraftOwner(async(path,init)=>{draftCalls.push(path);assert.equal(path,'/api/v1/ui/ui_fixture');assert.equal(init?.method,undefined);const read=[own,newest][draftCalls.length-1];assert(read,'Unexpected extra checkpoint read');return read.response;});
 const prior=owner.checkpoint,io=checkpointIO(f,{restoreDrafts:false});let task,latest,result,settled=false;
 try{
  task=f.track(f.client[method]({type:'SaveCheckpoint',name:'Original accepted checkpoint'}));void task.then(()=>{settled=true;},()=>{settled=true;});
  io.receiptGate.resolve();io.eventsGate.resolve();io.projectionGate.resolve();await Promise.race([own.entered.promise,task.then(()=>{throw Error('Command completed before checkpoint read');})]);
  assert.equal(io.eventsStarted,true);assert.equal(io.projectionStarted,true);assert.equal(own.body.locked,true);assert.equal(f.authority('checkpoint').length,0);
  latest=f.track(owner.restore());await Promise.race([newest.entered.promise,latest.then(()=>{throw Error('Latest restore completed before checkpoint read');})]);assert.equal(newest.body.locked,true);
  own.resume.resolve();await Promise.race([own.unlocked.promise,task.then(()=>{throw Error('Command completed before checkpoint unlock');})]);await turn();
  assert.equal(own.reads,2);assert.equal(own.cancels,0);assert.equal(own.unlocks,1);assert.equal(own.body.locked,false);
  assert.equal(settled,false);assert.equal(owner.checkpoint,prior);assert.equal(f.client.ui,prior);assert.equal(f.authority('checkpoint').length,0);assert.notEqual(f.client.view.message,'SaveCheckpoint accepted and saved locally.');
  newest.resume.resolve();await latest;result=await task;
  const events=method==='ownedCommand'?result.value:result;assert.deepEqual(events,[io.event]);assert.equal(events[0].payload.checkpoint.name,'Original accepted checkpoint');
  assert.equal(events[0].commandId,io.submitted.commandId);assert.equal(events[0].transactionId,io.submitted.transactionId);
  assert.equal(owner.checkpoint.uiSeq,'2');assert.equal(f.client.ui,owner.checkpoint);assert.notEqual(owner.checkpoint,prior);
  assert.equal(f.authority('checkpoint').length,1);assert.equal(f.authority('checkpoint')[0].input.commandId,io.submitted.commandId);assert.equal(f.client.view.message,'SaveCheckpoint accepted and saved locally.');
  assert.equal(io.paths.filter(path=>path==='/api/v1/commands').length,1);assert.equal(draftCalls.length,2);assert.deepEqual(f.journal.rows.get('command:'+io.submitted.commandId).result.receipt,io.receipt);
  assert.equal(newest.reads,2);assert.equal(newest.cancels,0);assert.equal(newest.unlocks,1);assert.equal(newest.body.locked,false);
  assert.equal(owner.ownership.controlReads,0);assert.equal(owner.ownership.controlCleanupFailures,0);assert.deepEqual(owner.pendingRequests(),[]);
 }finally{
  io.receiptGate.resolve();io.eventsGate.resolve();io.projectionGate.resolve();io.draftGate.resolve();own.resume.resolve();newest.resume.resolve();
  await Promise.allSettled([task,latest].filter(Boolean));if(method==='ownedCommand')result?.release();await f.close();
 }
});

test('owned accepted checkpoint refuses a failed newest real restore after its own valid response drains',async t=>{
 const f=await fixture(t),checkpoint={sessionId:'ui_fixture',uiSeq:'1',preferences:{documentId:f.document.id,selectedLayerIds:[]},drafts:[]};
 const own=heldCheckpointBody(f,checkpoint),newest=heldCheckpointBody(f,{...checkpoint,sessionId:'foreign_session',uiSeq:'2'}),draftCalls=[];
 const owner=f.installDraftOwner(async(path,init)=>{draftCalls.push(path);assert.equal(path,'/api/v1/ui/ui_fixture');assert.equal(init?.method,undefined);const read=[own,newest][draftCalls.length-1];assert(read,'Unexpected extra checkpoint read');return read.response;});
 const prior=owner.checkpoint,io=checkpointIO(f,{restoreDrafts:false});let task,latest,settled=false;
 try{
  task=f.track(f.client.ownedCommand({type:'SaveCheckpoint',name:'Accepted before restore failure'}));void task.then(()=>{settled=true;},()=>{settled=true;});
  io.receiptGate.resolve();io.eventsGate.resolve();io.projectionGate.resolve();await Promise.race([own.entered.promise,task.then(()=>{throw Error('Command completed before checkpoint read');})]);
  latest=f.track(owner.restore());await Promise.race([newest.entered.promise,latest.then(()=>{throw Error('Latest restore completed before checkpoint read');})]);own.resume.resolve();await Promise.race([own.unlocked.promise,task.then(()=>{throw Error('Command completed before checkpoint unlock');})]);await turn();
  assert.equal(own.reads,2);assert.equal(own.cancels,0);assert.equal(own.unlocks,1);assert.equal(own.body.locked,false);assert.equal(settled,false);assert.equal(f.authority('checkpoint').length,0);
  newest.resume.resolve();const [commandResult,restoreResult]=await Promise.allSettled([task,latest]);
  assert.equal(restoreResult.status,'rejected');assert.match(restoreResult.reason.message,/UI_CHECKPOINT_UNAVAILABLE/);assert.equal(commandResult.status,'rejected');assert.equal(commandResult.reason,restoreResult.reason);
  assert.equal(owner.checkpoint,prior);assert.equal(f.client.ui,prior);assert.equal(f.authority('checkpoint').length,0);assert.equal(f.states().some(row=>row.input.message==='SaveCheckpoint accepted and saved locally.'),false);
  assert.equal(io.paths.filter(path=>path==='/api/v1/commands').length,1);assert.equal(draftCalls.length,2);assert.deepEqual(f.journal.rows.get('command:'+io.submitted.commandId).result.receipt,io.receipt);
  assert.equal(newest.reads,2);assert.equal(newest.cancels,0);assert.equal(newest.unlocks,1);assert.equal(newest.body.locked,false);assert.equal(owner.ownership.controlReads,0);assert.equal(owner.ownership.controlCleanupFailures,0);
 }finally{
  io.receiptGate.resolve();io.eventsGate.resolve();io.projectionGate.resolve();io.draftGate.resolve();own.resume.resolve();newest.resume.resolve();
  await Promise.allSettled([task,latest].filter(Boolean));await f.close();
 }
});


// Real draft preparation, upload, command receipt/event proof and DraftPersistence
// paths. Only server IO/recovery/model loading are fixture boundaries; these do
// not qualify a browser, persistent store, painted status or physical timing.
function draftFeedbackIO(f){
 const paths=[],commands=[],stages=new Map(),uiRequests=[],events=[],releases=[],loads=[];
 const state={failure:null,holdReceipt:null,holdProof:null,receiptEntered:f.gate(),proofEntered:f.gate(),sequence:40};
 let checkpoint=structuredClone(f.client.ui),owner;
 const commandById=id=>{const value=commands.find(row=>row.command.commandId===id);assert(value,'Unknown original command '+id);return value;};
 const recoveryFor=row=>({recoveryId:'feedback_'+row.receipt.toSeq,writerEpoch:'1',projectionSchema:19,highWater:row.receipt.toSeq,expiresAt:'2099-01-01T00:00:00.000Z'});
 const transport=async(path,init)=>{
  paths.push({path,method:init?.method??'GET',body:init?.body});
  if(path==='/api/v1/assets/staging'&&init?.method==='POST'){
   const request=JSON.parse(init.body);assert.equal(request.protocolVersion,1);assert(!stages.has(request.stagingId));
   stages.set(request.stagingId,{...request,ownerClientId:f.client.owner,version:'1',committedOffset:'0',state:'receiving',bytes:Buffer.alloc(0)});return response({});
  }
  if(path.startsWith('/api/v1/assets/staging/')){
   const stage=stages.get(path.slice('/api/v1/assets/staging/'.length));assert(stage);
   if(init?.method==='PUT'){
    if(state.failure==='upload')throw Error('STORAGE_FULL');
    assert.equal(init.headers['Upload-Offset'],stage.committedOffset);stage.bytes=Buffer.concat([stage.bytes,Buffer.from(init.body)]);stage.committedOffset=String(stage.bytes.length);stage.state='complete';
    assert.equal(stage.committedOffset,stage.expectedBytes);assert.equal('sha256:'+createHash('sha256').update(stage.bytes).digest('hex'),stage.sha256);
   }else assert.equal(init?.method,undefined);
   const {bytes,...record}=stage;return response(record);
  }
  if(path==='/api/v1/commands'&&init?.method==='POST'){
   const request=JSON.parse(init.body),command=request.command,seq=String(++state.sequence);assert.equal(request.protocolVersion,1);
   assert(['FinalizeStaging','SaveCheckpoint'].includes(command.body.type));
   if(command.body.type==='FinalizeStaging'){const stage=stages.get(command.body.stagingId);assert(stage);assert.equal(stage.committedOffset,stage.expectedBytes);assert.equal(command.body.expectedSha256,stage.sha256);}
   const receipt=state.failure==='receipt-rejected'?{status:'rejected',commandId:command.commandId,code:'STALE_REVISION'}:{status:'accepted',commandId:command.commandId,transactionId:command.transactionId,fromSeq:seq,toSeq:seq,documentRevision:command.documentId?'4':null};
   commands.push({command,wire:init.body,receipt});
   if(command.body.type==='FinalizeStaging'){state.receiptEntered.resolve();await state.holdReceipt?.promise;}
   if(state.failure==='receipt-lost')throw Error('Failed to fetch');
   return response({protocolVersion:1,kind:'receipt',receipt});
  }
  const commandPath=/^\/api\/v1\/commands\/([^/]+)(\/result)?$/.exec(path);
  if(commandPath){
   const row=commandById(commandPath[1]);
   if(!commandPath[2])return response({protocolVersion:1,kind:'receipt',receipt:row.receipt});
   const {command,receipt}=row,recovery=recoveryFor(row),stage=stages.get(command.body.stagingId),asset=stage?{id:'asset_'+receipt.toSeq,version:'1',purpose:stage.purpose,blob:{hash:stage.sha256,byteLength:stage.expectedBytes,mediaType:stage.mediaType},dependencies:[],safety:stage.purpose==='caption'?'safe':'unknown',availability:'available',qualification:stage.purpose==='caption'?'opaque-text':'pending-text',measuredMediaType:stage.mediaType}:undefined;
   const event={schemaVersion:1,payloadVersion:1,eventId:'event_'+receipt.toSeq,workspaceSeq:receipt.toSeq,streamId:asset?'assets':f.document.id,streamSeq:asset?receipt.toSeq:'4',documentId:asset?null:f.document.id,resultingDocumentRevision:asset?null:'4',commandId:command.commandId,correlationId:command.correlationId,causationId:null,transactionId:command.transactionId,writerEpoch:'1',recordedAt:'2026-10-04T01:11:37.325Z',type:asset?'AssetRegistered':'CheckpointSaved',payload:asset?{asset}:{checkpoint:{id:'checkpoint_'+receipt.toSeq,name:command.body.name,documentId:f.document.id,documentRevision:'4',historyHead:'history_4',highWater:'40'}}};
   if(state.failure==='events')event.commandId='foreign_command';events.push(event);
   return response({protocolVersion:1,kind:'batches',recovery,nextCursor:receipt.toSeq,more:false,batches:[{kind:'inline',transactionId:receipt.transactionId,fromSeq:receipt.fromSeq,toSeq:receipt.toSeq,events:[event]}]});
  }
  const proofPath=/^\/api\/v1\/events\?after=([0-9]+)&recoveryId=feedback_([0-9]+)$/.exec(path);
  if(proofPath){
   assert.equal(proofPath[1],proofPath[2]);const row=commands.find(row=>row.receipt.toSeq===proofPath[1]);assert(row);state.proofEntered.resolve();await state.holdProof?.promise;
   return response({protocolVersion:1,kind:'batches',recovery:recoveryFor(row),nextCursor:proofPath[1],more:false,batches:[]});
  }
  const releasePath=/^\/api\/v1\/recovery\/feedback_([0-9]+)\/release$/.exec(path);
  if(releasePath){assert.equal(init.method,'POST');assert.deepEqual(JSON.parse(init.body),{protocolVersion:1});releases.push(releasePath[1]);return new Response(null,{status:204});}
  if(path==='/api/v1/ui/ui_fixture'){
   if(init?.method==='POST'){
    const request=JSON.parse(init.body);uiRequests.push(request);assert.equal(request.body.type,'SaveDraft');assert.equal(request.sessionId,checkpoint.sessionId);assert.equal(request.expectedUISeq,checkpoint.uiSeq);
    const rejected=state.failure==='draft-rejected';if(!rejected)checkpoint={...checkpoint,uiSeq:String(BigInt(checkpoint.uiSeq)+1n),drafts:[{...request.body.draft,status:'saved-unapplied'}]};
    return response({protocolVersion:1,requestId:request.requestId,status:rejected?'rejected':'accepted',uiSeq:checkpoint.uiSeq,...(rejected?{reason:'DRAFT_CHANGED'}:{})});
   }
   assert.equal(init?.method,undefined);return response(state.failure==='draft-restore'?{...checkpoint,sessionId:'foreign_session'}:checkpoint);
  }
  throw Error('Unexpected draft feedback path '+path);
 };
 f.setTransport(transport);owner=f.installDraftOwner(transport);f.client.patch({document:f.document});delete f.client.draftStatus;
 f.client.sync=async()=>{if(state.failure==='recovery')throw Error('RECOVERY_REFUSED');f.setCursor(String(state.sequence));};
 f.client.loadDocument=async document=>{loads.push(document.id);};f.journal.get=async key=>structuredClone(f.journal.rows.get(key));
 const draft=(kind,text)=>{owner.change({id:'feedback_draft',kind,text,documentId:f.document.id,targetLayerId:kind==='inspector'||kind==='mask'?'layer_1':null,expectedDocumentRevision:'4',composing:false});};
 return {state,paths,commands,stages,uiRequests,events,releases,loads,owner,draft};
}
const draftFeedbackValues={
 inspector:'{"a":"30","b":"0","c":"0","d":"30","x":"10","y":"5"}',
 prompt:'Retained prompt',mask:'{"points":[[1,2],[3,4]]}',
 request:JSON.stringify({draft:{prompt:{text:null}},text:'Request prompt'}),
 composition:JSON.stringify({composition:{raw:[],review:null},bindings:[]}),
 text:JSON.stringify({text:'Retained native text',style:{family:'Fixture',size:16},frame:{x:0,y:0,width:128,height:32},fonts:[]}),
};
for(const kind of Object.keys(draftFeedbackValues))test(kind+' draft saves through real staging and complete events without taking operation status',async t=>{
 const f=await fixture(t),io=draftFeedbackIO(f),message='ApplyTransform accepted and saved locally.',recovery='Retained recovery warning',error='Retained diagnostic';
 io.draft(kind,draftFeedbackValues[kind]);f.client.patch({message,recovery,error});const begin=f.calls.length;
 await f.track(f.client.flushDrafts());
 assert.equal(f.client.view.message,message);assert.equal(f.client.view.recovery,recovery);assert.equal(f.client.view.error,error);assert.equal(f.client.view.drafts,'Draft saved locally; not applied to the document');
 const expected=['request','composition','text'].includes(kind)?2:1;assert.equal(io.commands.length,expected);assert.equal(io.events.length,expected);assert.equal(io.releases.length,expected);assert.equal(io.stages.size,expected);
 assert(io.commands.every(row=>row.command.body.type==='FinalizeStaging'));assert.equal(io.uiRequests.length,1);assert.equal(io.uiRequests[0].body.draft.kind,kind);assert.equal(io.uiRequests[0].body.draft.assetId,'asset_'+io.commands.at(-1).receipt.toSeq);
 assert.equal(io.owner.drafts.get('feedback_draft').savedGeneration,'1');assert.equal(io.owner.drafts.get('feedback_draft').error,null);assert.deepEqual(io.loads,[f.document.id]);assert.deepEqual(io.owner.pendingRequests(),[]);
 assert(f.calls.slice(begin).filter(row=>row.type==='state').every(row=>row.input.message===message&&row.input.hasRecovery&&row.input.hasError));
 for(const row of io.commands){const saved=f.journal.rows.get('command:'+row.command.commandId);assert.equal(saved.wire,row.wire);assert.deepEqual(saved.request.command,row.command);assert.deepEqual(saved.result.receipt,row.receipt);assert.equal(Object.hasOwn(saved,'announce'),false);}
 await f.close();
});

test('a held inspector save cannot overwrite a later genuine foreground command completion',async t=>{
 const f=await fixture(t),io=draftFeedbackIO(f);io.state.holdReceipt=f.gate();io.draft('inspector',draftFeedbackValues.inspector);
 const saving=f.track(f.client.flushDrafts());await io.state.receiptEntered.promise;
 await f.track(f.client.withCommandEvents({type:'SaveCheckpoint',name:'Later user operation'},events=>{assert.equal(events[0].type,'CheckpointSaved');assert.equal(events[0].payload.checkpoint.name,'Later user operation');}));
 const message=f.client.view.message;assert.equal(message,'SaveCheckpoint accepted and saved locally.');assert.equal(f.authority('checkpoint').length,1);const begin=f.calls.length;
 io.state.holdReceipt.resolve();await saving;
 assert.equal(f.client.view.message,message);assert.equal(io.commands.length,2);assert.equal(io.commands[0].command.body.type,'FinalizeStaging');assert.equal(io.commands[1].command.body.type,'SaveCheckpoint');assert.equal(io.releases.length,2);assert.equal(io.uiRequests.length,1);
 assert(f.calls.slice(begin).filter(row=>row.type==='state').every(row=>row.input.message===message));await f.close();
});

for(const entry of ['caption','ownedStageTextBlob'])test('explicit '+entry+' preserves ordinary FinalizeStaging success feedback',async t=>{
 const f=await fixture(t),io=draftFeedbackIO(f);f.client.patch({message:'User staging…',recovery:'Old warning'});
 const result=await f.track(entry==='caption'?f.client.caption('Explicit caption'):f.client.ownedStageTextBlob(new Blob(['Explicit native text']),'text/plain'));
 assert.equal(f.client.view.message,'FinalizeStaging accepted and saved locally.');assert.equal(f.client.view.recovery,'');assert.equal(io.commands.length,1);assert.equal(io.releases.length,1);assert.deepEqual(io.uiRequests,[]);result?.release?.();await f.close();
});

test('draft success remains pending through its exact event proof while a newer diagnostic survives',async t=>{
 const f=await fixture(t),io=draftFeedbackIO(f);io.state.holdProof=f.gate();io.draft('inspector',draftFeedbackValues.inspector);let settled=false;
 const task=f.track(f.client.flushDrafts());void task.then(()=>{settled=true;},()=>{settled=true;});await io.state.proofEntered.promise;
 assert.equal(settled,false);assert.deepEqual(io.uiRequests,[]);assert.equal(io.owner.drafts.get('feedback_draft').savedGeneration,null);
 f.client.fail(Error('NEW_FOREGROUND_FAILURE'));const begin=f.calls.length;io.state.holdProof.resolve();await task;
 assert.equal(f.client.view.message,'Action needs attention.');assert.equal(f.client.view.error,'NEW_FOREGROUND_FAILURE');assert.equal(io.releases.length,1);assert.equal(io.owner.drafts.get('feedback_draft').savedGeneration,'1');
 assert(f.calls.slice(begin).filter(row=>row.type==='state').every(row=>row.input.message==='Action needs attention.'&&row.input.hasError));await f.close();
});

for(const failure of ['upload','receipt-rejected','receipt-lost','events','recovery','draft-restore','draft-rejected'])test('background '+failure+' retains its failure and cannot report silent draft success',async t=>{
 const f=await fixture(t),io=draftFeedbackIO(f);io.state.failure=failure;io.draft('inspector',draftFeedbackValues.inspector);f.client.patch({message:'Prior user result',recovery:'Retained recovery'});
 let original;await f.track(f.client.flushDrafts().catch(error=>{original=error;f.client.fail(error);}));assert(original instanceof Error);
 assert.equal(f.client.view.message,'Action needs attention.');assert(f.client.view.error.length>0);assert.equal(f.client.view.recovery,'Retained recovery');assert.equal(io.owner.drafts.get('feedback_draft').savedGeneration,null);assert(io.owner.drafts.get('feedback_draft').error);
 assert.equal(io.uiRequests.length,failure==='draft-rejected'?1:0);assert.equal(io.commands.length,failure==='upload'?0:1);
 for(const row of io.commands){const saved=f.journal.rows.get('command:'+row.command.commandId);assert.equal(saved.wire,row.wire);assert.deepEqual(saved.request.command,row.command);}
 if(['events','recovery','draft-restore','draft-rejected'].includes(failure))assert.equal(io.releases.length,1);
 assert.equal(f.states().some(row=>row.input.message==='FinalizeStaging accepted and saved locally.'),false);await f.close();
});

test('explicit retry of an uncertain background finalization keeps original wire and announces verified success',async t=>{
 const f=await fixture(t),io=draftFeedbackIO(f);io.state.failure='receipt-lost';io.draft('inspector',draftFeedbackValues.inspector);
 await assert.rejects(f.track(f.client.flushDrafts()),/Failed to fetch/);const row=io.commands[0],saved=f.journal.rows.get('command:'+row.command.commandId);assert.equal(saved.wire,row.wire);assert.equal(saved.result,undefined);
 io.state.failure=null;f.client.patch({message:'Retry original operation…',recovery:'Old warning'});const result=await f.track(f.client.ownedRetry(row.command.commandId));
 assert.equal(result.value[0].type,'AssetRegistered');assert.equal(io.commands.length,1);assert.equal(io.paths.filter(row=>row.path==='/api/v1/commands'&&row.method==='POST').length,1);assert(io.paths.some(entry=>entry.path==='/api/v1/commands/'+row.command.commandId&&entry.method==='GET'));
 assert.equal(f.journal.rows.get('command:'+row.command.commandId).wire,row.wire);assert.equal(f.client.view.message,'FinalizeStaging accepted and saved locally.');assert.equal(f.client.view.recovery,'');assert.equal(io.owner.drafts.get('feedback_draft').savedGeneration,null);assert.deepEqual(io.uiRequests,[]);result.release();await f.close();
});

for(const replacement of ['sessionIdentity','documentGeneration'])test('background staging stays fenced after '+replacement+' replacement',async t=>{
 const f=await fixture(t),io=draftFeedbackIO(f);io.state.holdReceipt=f.gate();io.draft('inspector',draftFeedbackValues.inspector);
 const task=f.track(f.client.flushDrafts());await io.state.receiptEntered.promise;invalidateOpen[replacement](f);f.client.patch({message:'Replacement owner result'});io.state.holdReceipt.resolve();
 await assert.rejects(task,/owner changed|superseded|abort/i);assert.equal(f.client.view.message,'Replacement owner result');assert.deepEqual(io.uiRequests,[]);assert.deepEqual(io.events,[]);assert.equal(io.commands.length,1);assert.equal(f.journal.rows.get('command:'+io.commands[0].command.commandId).wire,io.commands[0].wire);await f.close();
});

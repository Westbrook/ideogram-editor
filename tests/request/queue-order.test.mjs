// Explicit merge of backend10 queue behavior and UI08 retained-response ownership.
// Both predecessor identities and case-family disposition are sealed in the packet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,until,turn,deferred} from './queue-order-controls.mjs';

const confirmation='Cancel waiting intent and open replacement draft';
async function waitingFixture(t){
 const f=await fixture(t),queue=f.getQueue(),owner=f.editor.draftOwner;
 owner.checkpoint={sessionId:'session',uiSeq:'8',drafts:[]};owner.pendingDelivery=false;owner.hasRefusedChanges=false;
 const first={...queue.jobs[0],ownerClientId:'client',review:{endpoint:'ideogram/v4/generate',request:{kind:'generate',settings:{count:1}}},order:{insertionOrdinal:'1',position:'1',origin:'accepted'}};
 first.attempts=[{...first.attempts[0],state:'not-started',requestId:null,count:'none',hold:false,recoveryRequired:false}];
 const second={...structuredClone(first),id:'second',version:'9',order:{insertionOrdinal:'2',position:'2',origin:'accepted'}};
 queue.jobs=[first,second];queue.totalJobs=2;queue.orderVersion='17';queue.orderEpoch='3';
 queue.waiting={job:{position:1,previous:null,next:{id:'second',version:'9'},reason:'Waiting for explicit provider authorization',editable:true},second:{position:2,previous:{id:'job',version:'5'},next:null,reason:'Waiting for explicit provider authorization',editable:true}};
 f.setQueue(queue);await f.flow.refreshQueue();f.stopPoll();
 const opened=[];f.editor.refreshQueuedReplacement=async(...args)=>{opened.push(args);};
 f.editor.command=async body=>{f.commands.push(structuredClone(body));return [];};
 return {...f,opened};
}

test('rendered waiting actions submit the exact displayed adjacent job and order versions once',async t=>{
 const f=await waitingFixture(t);assert.equal(f.button('Move up waiting job job').disabled,true);assert.equal(f.button('Move down waiting job second').disabled,true);
 f.click('Move down waiting job job');await until(()=>f.commands.length===1);await turn();
 assert.deepEqual(f.commands,[{type:'ReorderLocalQueue',jobId:'job',expectedVersion:'5',neighborId:'second',expectedNeighborVersion:'9',expectedOrderVersion:'17',direction:'down'}]);
 assert.equal(f.flow.queueCursor,'');assert.deepEqual(f.opened,[]);assert.equal(f.scopes.length,1);assert.equal(f.scopes[0].released,true);
});

test('an older rendered move action never substitutes a refreshed neighbor or order token',async t=>{
 const f=await waitingFixture(t),old=f.button('Move down waiting job job'),queue=f.getQueue(),prior=f.models.find(value=>value.model.value===f.flow.queue);assert(prior);
 queue.orderVersion='18';queue.waiting.job.next={id:'different-neighbor',version:'11'};f.setQueue(queue);await f.flow.refreshQueue();
 await turn();assert.equal(prior.released,true);assert.throws(()=>prior.model.pin(),/MODEL_MEMORY_RELEASED/);
 old.click(f.event());await turn();await turn();
 assert.deepEqual(f.commands,[]);assert.deepEqual(f.scopes,[]);
});

test('a stale rendered edit confirmation cannot authorize a newly selected waiting intent',async t=>{
 const f=await waitingFixture(t);f.click('Edit waiting job job');await turn();const old=f.button(confirmation);
 f.click('Edit waiting job second');await turn();old.click(f.event());await turn();await turn();
 assert.deepEqual(f.commands,[]);assert.deepEqual(f.opened,[]);
 f.click(confirmation);await until(()=>f.commands.length===1);
 assert.equal(f.commands[0].type,'EditQueuedJob');assert.equal(f.commands[0].jobId,'second');assert.equal(f.commands[0].expectedVersion,'9');assert.equal(f.commands[0].expectedUISeq,'8');assert.equal(f.commands[0].sessionId,'session');assert.match(f.commands[0].replacementDraftId,/^[0-9a-f-]{36}$/);
});

test('an auth-independent waiting summary never exposes Edit for another client owner',async t=>{
 const f=await waitingFixture(t),queue=f.getQueue();queue.jobs[0].ownerClientId='another-client';queue.jobs[1].ownerClientId=null;f.setQueue(queue);await f.flow.refreshQueue();
 assert.equal(f.render().buttons.some(button=>button.name.startsWith('Edit waiting job')),false);assert.equal(f.button('Move down waiting job job').disabled,false);
});

test('an owned waiting job in another document requires opening that document before cancellation or edit',async t=>{
 const f=await waitingFixture(t),queue=f.getQueue();for(const job of queue.jobs)job.documentId='another-document';f.setQueue(queue);await f.flow.refreshQueue();
 assert.equal(f.render().buttons.some(button=>button.name.startsWith('Edit waiting job')),false);assert.match(f.render().text,/Open this job.s document to edit its waiting request/);assert.deepEqual(f.commands,[]);assert.deepEqual(f.opened,[]);
});

for(const boundary of ['document','owner'])test('opening another '+boundary+' clears the previous waiting-edit confirmation',async t=>{
 const f=await waitingFixture(t);f.click('Edit waiting job job');await turn();assert(f.button(confirmation));
 if(boundary==='document')f.editor.view.document={id:'another-document',revision:'1'};
 else f.editor.draftOwner={drafts:new Map()};
 await f.flow.sync();assert.equal(f.render().buttons.some(button=>button.name===confirmation),false);assert.equal(f.flow.queueEditReview,null);assert.deepEqual(f.commands,[]);
});

// Preserve the backend predecessor's same-confirmation transition between two
// refusal causes, using the owned controller's scalar pending-delivery contract.
test('replacement confirmation waits for saved input and rejects unresolved delivery or refused input',async t=>{
 const f=await waitingFixture(t);f.click('Edit waiting job job');await turn();const review=f.flow.queueEditReview,flush=f.editor.flushDrafts.bind(f.editor);let flushes=0;
 f.editor.flushDrafts=async()=>{flushes++;await flush();};
 for(const [index,state] of ['pending','refused'].entries()){
  f.editor.draftOwner.pendingDelivery=state==='pending';f.editor.draftOwner.hasRefusedChanges=state==='refused';
  f.click(confirmation);await turn();await turn();assert.equal(flushes,index+1);assert.equal(f.flow.queueEditReview,review);assert.deepEqual(f.commands,[]);assert.deepEqual(f.scopes,[]);assert.deepEqual(f.opened,[]);
 }
});

for(const state of ['unsaved','pending','composing','error','refused','unknown-delivery','missing-checkpoint'])test('replacement confirmation preserves '+state+' input without dispatching an edit',async t=>{
 const f=await waitingFixture(t);f.click('Edit waiting job job');await turn();
 f.editor.flushDrafts=async()=>{};const owner=f.editor.draftOwner,draft={id:'local-input',text:'exact current input',generation:'2',savedGeneration:'2',pending:false,composing:false,error:null};owner.drafts.clear();owner.drafts.set(draft.id,draft);
 if(state==='unsaved')draft.savedGeneration='1';if(state==='pending')draft.pending=true;if(state==='composing')draft.composing=true;if(state==='error')draft.error='retained failure';if(state==='refused')owner.hasRefusedChanges=true;if(state==='unknown-delivery')owner.pendingDelivery=true;if(state==='missing-checkpoint')owner.checkpoint=null;
 f.click(confirmation);await turn();await turn();assert.deepEqual(f.commands,[]);assert.deepEqual(f.scopes,[]);assert.deepEqual(f.opened,[]);assert.equal(owner.drafts.get(draft.id),draft);assert.equal(draft.text,'exact current input');
});

test('stale reordered pagination keeps retained rows and offers an explicit first-page restart',async t=>{
 const f=await waitingFixture(t),queue=f.getQueue(),cursor='q1:3:20:retained-anchor',reads=[];
 queue.nextCursor=cursor;f.setQueue(queue);await f.flow.refreshQueue();f.click('Next retained jobs');await until(()=>f.flow.queueCursor===cursor);f.stopPoll();
 const rows=structuredClone(f.flow.queue.jobs),json=f.editor.json;f.editor.json=async path=>{reads.push(path);if(path.includes('?after='))throw Error('STALE_EPOCH');return json(path);};
 await assert.rejects(f.flow.refreshQueue(),/STALE_EPOCH/);assert.deepEqual(f.flow.queue.jobs,rows);assert.equal(f.flow.queueCursor,cursor);assert.match(f.render().text,/changed local order|Local queue order changed/);assert.equal(f.button('First retained jobs').disabled,false);
 f.click('First retained jobs');await until(()=>f.flow.queueCursor==='');assert.equal(reads.at(-1),'/api/v1/queue');assert.deepEqual(f.commands,[]);
});

for(const boundary of ['document','document-epoch','session-object','dispose'])for(const outcome of ['resolve','reject'])test('a delayed replacement checkpoint '+outcome+' cannot publish after '+boundary,async t=>{
 const f=await waitingFixture(t),read=deferred();let entered=false;
 f.releaseOnClose(read);
 f.editor.command=async body=>{f.commands.push(structuredClone(body));return [{type:'QueueStateChanged',payload:{}}];};
 f.editor.refreshQueuedReplacement=async()=>{entered=true;await read.promise;};
 f.click('Edit waiting job job');await turn();f.click(confirmation);await until(()=>entered);
 if(boundary==='document'){f.editor.view.document={id:'another-document',revision:'1'};await f.flow.sync();}
 if(boundary==='document-epoch')f.editor.documentEpoch++;
 if(boundary==='session-object')f.editor.session={...f.editor.session};
 let disposed;if(boundary==='dispose')disposed=f.flow.dispose();
 const before={text:f.render().text,message:f.flow.message,preferred:f.flow.preferredQueuedDraftId};
 read[outcome](outcome==='reject'?Error('late old-checkpoint failure'):undefined);await turn();await turn();await disposed;assert.deepEqual({text:f.render().text,message:f.flow.message,preferred:f.flow.preferredQueuedDraftId},before);assert.equal(f.commands.length,1);assert(f.scopes.every(scope=>scope.released));
});

test('exact replacement draft is selected even when another saved draft shares its operation and prompt mode',async t=>{
 const f=await waitingFixture(t),draft=structuredClone(f.flow.entry().draft),owner={drafts:new Map()};
 const saved=id=>({id,generation:'1',kind:'request',documentId:'doc',targetLayerId:null,expectedDocumentRevision:'1',assetId:'asset-'+id,status:'saved-unapplied',composing:false});
 f.editor.draftOwner=owner;f.editor.ui={drafts:[saved('exact-replacement'),saved('later-same-operation')]};
 f.flow.preferredQueuedDraftId='exact-replacement';f.flow.preferredQueuedOwner=owner;
 f.editor.json=async path=>path.includes('/request?')?{value:structuredClone(draft)}:{items:[]};f.editor.session.transport=async()=>new Response('');
 await f.flow.sync();assert.equal(f.flow.entry().id,'exact-replacement');assert.equal(f.flow.preferredQueuedDraftId,null);assert.equal(f.flow.review,null);assert.equal(f.flow.accepted,false);assert.deepEqual(f.commands,[]);
});

test('rendered waiting movement retains only displayed scalar fields when its old row graph becomes unreadable',async t=>{
 const f=await waitingFixture(t),callback=f.button('Move down waiting job job').click,row=f.flow.queue.jobs[0],waiting=f.flow.queue.waiting.job;
 for(const [value,keys] of [[row,['id','version','review','order']],[waiting,['next','previous']]])for(const key of keys)Object.defineProperty(value,key,{configurable:true,get(){throw Error('Rendered callback borrowed the old row graph');}});
 callback(f.event());await until(()=>f.commands.length===1);await until(()=>!f.flow.queueBusy);
 assert.deepEqual(f.commands[0],{type:'ReorderLocalQueue',jobId:'job',expectedVersion:'5',neighborId:'second',expectedNeighborVersion:'9',expectedOrderVersion:'17',direction:'down'});assert.equal(f.scopes[0].summary,0);assert.equal(f.scopes[0].released,true);
});

test('queue event ownership ends before the delayed refresh and only scalar saved evidence reaches its callback',async t=>{
 const f=await waitingFixture(t),gate=deferred(),entered=deferred(),read=f.editor.json,saved=[];f.editor.command=async body=>{f.commands.push(structuredClone(body));return [{type:'QueueStateChanged',payload:{nested:{exact:'private retained event'}}},{type:'JobQueued',payload:{}}];};
 f.releaseOnClose(gate);
 f.editor.json=async path=>{if(path.startsWith('/api/v1/queue')){entered.resolve();await gate.promise;}return read(path);};const pending=f.flow.queueCommand({type:'CancelUnstartedJob',jobId:'job',expectedVersion:'5'},value=>saved.push(value));
 try{await entered.promise;assert.equal(f.scopes.length,1);assert.equal(f.scopes[0].released,true);assert.equal(f.scopes[0].summary,3);assert.throws(()=>f.scopes[0].model.pin(),/MODEL_MEMORY_RELEASED/);assert.deepEqual(saved,[]);}finally{gate.resolve();}
 assert.equal(await pending,undefined);assert.deepEqual(saved,[true]);
});

for(const boundary of ['document','session-object','dispose'])test('a late owned queue result cannot report saved evidence after '+boundary,async t=>{
 const f=await waitingFixture(t),gate=deferred(),saved=[];f.editor.command=async body=>{f.commands.push(structuredClone(body));return gate.promise;};const pending=f.flow.queueCommand({type:'CancelUnstartedJob',jobId:'job',expectedVersion:'5'},value=>saved.push(value));
 f.releaseOnClose(gate);
 await until(()=>f.commands.length===1);if(boundary==='document')f.editor.view.document={id:'successor',revision:'1'};if(boundary==='session-object')f.editor.session={...f.editor.session};let disposed;if(boundary==='dispose')disposed=f.flow.dispose();gate.resolve([{type:'QueueStateChanged',payload:{nested:{value:'old event'}}}]);await pending;await disposed;
 assert.deepEqual(saved,[]);assert.equal(f.scopes.length,1);assert.equal(f.scopes[0].summary,2);assert.equal(f.scopes[0].released,true);assert.throws(()=>f.scopes[0].model.pin(),/MODEL_MEMORY_RELEASED/);
});

test('a failed refresh releases command evidence and cannot authorize opening a replacement',async t=>{
 const f=await waitingFixture(t),saved=[];f.editor.command=async body=>{f.commands.push(structuredClone(body));return [{type:'QueueStateChanged',payload:{nested:{value:'retained'}}}];};const read=f.editor.json;f.editor.json=async path=>{if(path.startsWith('/api/v1/queue'))throw Error('fixture refresh unavailable');return read(path);};
 await assert.rejects(f.flow.queueCommand({type:'EditQueuedJob',jobId:'job',expectedVersion:'5',sessionId:'session',expectedUISeq:'8',replacementDraftId:'replacement'},value=>saved.push(value)),/fixture refresh unavailable/);assert.deepEqual(saved,[]);assert.equal(f.scopes[0].released,true);assert.throws(()=>f.scopes[0].model.pin(),/MODEL_MEMORY_RELEASED/);assert.deepEqual(f.opened,[]);
});

test('an edit response without durable state change evidence does not open a replacement checkpoint',async t=>{
 const f=await waitingFixture(t);f.editor.command=async body=>{f.commands.push(structuredClone(body));return [{type:'LocalQueueReordered',payload:{}}];};f.click('Edit waiting job job');await turn();f.click(confirmation);await until(()=>f.commands.length===1);await until(()=>!f.flow.queueBusy);await turn();assert.deepEqual(f.opened,[]);assert.equal(f.scopes[0].summary,0);assert.equal(f.scopes[0].released,true);
});

for(const boundary of ['draft-flush','command'])test('same-document lifetime replacement during '+boundary+' cannot begin checkpoint adoption',async t=>{
 const f=await waitingFixture(t),gate=deferred();let entered=false;
 f.releaseOnClose(gate);
 if(boundary==='draft-flush')f.editor.flushDrafts=async()=>{entered=true;await gate.promise;};
 else f.editor.command=async body=>{f.commands.push(structuredClone(body));entered=true;await gate.promise;return [{type:'QueueStateChanged',payload:{}}];};
 f.click('Edit waiting job job');await turn();f.click(confirmation);await until(()=>entered);f.editor.documentEpoch++;gate.resolve();await turn();await turn();await until(()=>!f.flow.queueBusy);
 assert.equal(f.commands.length,boundary==='command'?1:0);assert.deepEqual(f.opened,[]);assert.equal(f.flow.preferredQueuedDraftId,null);assert(f.scopes.every(scope=>scope.released));
});

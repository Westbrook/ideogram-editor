// Execute the exact promoted owner-adoption and retirement methods with real
// persistence, checkpoint and draft owners; isolate unrelated browser constructors.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {allocationsURL,promptMemoryURL} from '../owned-preview-module.mjs';
import {draftStateDependencies,jsonResponse} from '../draft-state-module.mjs';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const {draftURL:persistenceURL,memoryURL}=await draftStateDependencies(allocationsURL,{promptURL:promptMemoryURL});
let fence=(await transformWithOxc(await readFile('src/state/queued-replacement-fence.ts','utf8'),'queued-replacement-fence.ts')).code;
fence=fence.replaceAll(JSON.stringify('../observability/model-memory.js'),JSON.stringify(memoryURL)).replaceAll("'../observability/model-memory.js'",JSON.stringify(memoryURL));
const fenceURL=data(fence),source=await readFile('src/state/editor-client.ts','utf8');
const start=source.indexOf('  async refreshQueuedReplacement('),end=source.indexOf('  async retryDraft(',start);
const ownershipStart=source.indexOf('  get ui(){'),ownershipEnd=source.indexOf('  pinUI(){',ownershipStart);
assert(start>=0&&end>start,'Expected the real EditorClient replacement adoption method');
assert(ownershipStart>=0&&ownershipEnd>ownershipStart,'Expected the real EditorClient checkpoint ownership and retirement methods');
const method=source.slice(start,end),ownership=source.slice(ownershipStart,ownershipEnd);
const code=(await transformWithOxc('import {DraftPersistence} from '+JSON.stringify(persistenceURL)+';import {captureQueuedReplacementFence,queuedDraftsClean,queuedReplacementOperation} from '+JSON.stringify(fenceURL)+';export class OwnerHarness {\nretiredDraftOwners=new Set();draftOwnerDrains=new Map();\n'+ownership+'\n'+method+'\n}','owner-harness.ts')).code;
const {OwnerHarness}=await import(data(code)),{DraftPersistence}=await import(persistenceURL);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(t){
 const entered=deferred(),response=deferred(),session={identity:()=> 'client',csrf:()=>'',transport:async()=>{entered.resolve();return response.promise;}};
 const original=new DraftPersistence('session',session.transport,session.csrf);
 original.checkpoint={sessionId:'session',uiSeq:'1',drafts:[],preferences:{documentId:'doc',selectedLayerIds:[]}};
 original.change({id:'existing-draft',kind:'request',documentId:'doc',targetLayerId:null,expectedDocumentRevision:'1',composing:false,text:'original saved text'});
 original.drafts.get('existing-draft').savedGeneration='1';
 const checkpoint={sessionId:'session',uiSeq:'2',drafts:[{id:'replacement',generation:'1',kind:'request',status:'saved-unapplied',documentId:'doc',targetLayerId:null,expectedDocumentRevision:'1',assetId:'saved-authored-bytes',composing:false}],preferences:{documentId:'doc',selectedLayerIds:[]}};
 const client=Object.assign(new OwnerHarness(),{draftOwner:original,sessionId:'session',lifecycle:1,documentLifetime:1,view:{document:{id:'doc',revision:'1'}},uiTail:Promise.resolve(),ui:original.checkpoint,session,patches:[],failures:[],patch(value){this.patches.push(value);},fail(error){this.failures.push(error);}});
 t.after(async()=>{client.ui=undefined;await Promise.all([...new Set([original,client.draftOwner])].map(owner=>client.retireDraftOwner(owner)));await client.drainDraftOwners();assert.deepEqual(client.failures,[]);});
 return {client,original,get local(){return original.drafts.get('existing-draft');},entered,finish:()=>response.resolve(jsonResponse(checkpoint)),checkpoint};
}

test('replacement checkpoint adoption retains its exact draft identity and closes only the prior clean owner',async t=>{
 const f=fixture(t),pending=f.client.refreshQueuedReplacement('replacement',f.original,'session');await f.entered.promise;f.finish();await pending;
 assert.notEqual(f.client.draftOwner,f.original);assert.equal(f.original.disposed,true);assert.equal(f.client.ui.drafts[0].id,'replacement');assert.equal(f.client.ui.drafts[0].assetId,'saved-authored-bytes');assert.equal(f.client.patches.length,1);
});

for(const change of ['unsaved-input','saved-input','checkpoint-sequence','session-object','document-owner'])test('delayed replacement read preserves concurrent '+change,async t=>{
 const f=fixture(t),pending=f.client.refreshQueuedReplacement('replacement',f.original,'session');await f.entered.promise;
 if(change==='unsaved-input')f.original.change({...f.local,text:'new exact unsaved input'});
 if(change==='saved-input'){f.original.change({...f.local,text:'new exact saved input'});f.local.savedGeneration=f.local.generation;f.original.checkpoint.uiSeq='3';}
 if(change==='checkpoint-sequence')f.original.checkpoint.uiSeq='3';
 if(change==='session-object')f.client.session={...f.client.session};
 if(change==='document-owner')f.client.documentLifetime++;
 f.finish();await assert.rejects(pending,/changed|current input|recovery/i);
 assert.equal(f.client.draftOwner,f.original);assert.equal(f.original.disposed,false);assert.equal(f.client.ui,f.original.checkpoint);assert.deepEqual(f.client.patches,[]);if(change.includes('input'))assert.match(f.local.text,/new exact/);
});

test('missing exact replacement never switches owner or picks another saved request',async t=>{
 const f=fixture(t);f.checkpoint.drafts[0].id='different-request';const pending=f.client.refreshQueuedReplacement('replacement',f.original,'session');await f.entered.promise;f.finish();await assert.rejects(pending,/saved replacement/i);assert.equal(f.client.draftOwner,f.original);assert.equal(f.original.disposed,false);assert.deepEqual(f.client.patches,[]);
});

test('an obsolete consumer cannot begin restoring or adopting a replacement checkpoint',async t=>{
 const f=fixture(t);let reads=0,adopted=0;f.client.session.transport=async()=>{reads++;return jsonResponse(f.checkpoint);};
 await assert.rejects(f.client.refreshQueuedReplacement('replacement',f.original,'session',()=>{adopted++;},()=>false),/current input/i);
 assert.equal(reads,0);assert.equal(adopted,0);assert.equal(f.client.draftOwner,f.original);assert.equal(f.original.disposed,false);assert.deepEqual(f.client.patches,[]);
});

test('consumer disposal during the replacement read forbids adoption and its callback',async t=>{
 const f=fixture(t);let active=true,adopted=0;const pending=f.client.refreshQueuedReplacement('replacement',f.original,'session',()=>{adopted++;},()=>active);await f.entered.promise;active=false;f.finish();
 await assert.rejects(pending,/changed|recovery/i);assert.equal(adopted,0);assert.equal(f.client.draftOwner,f.original);assert.equal(f.original.disposed,false);assert.deepEqual(f.client.patches,[]);
});

import {allocationsURL,promptMemoryURL} from '../owned-preview-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transformWithOxc} from 'vite';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function module(path,replacements={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url] of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const resourcesURL=await module('src/state/document-lifecycle.ts'),draftURL=await module('src/state/draft-persistence.ts',{'../observability/allocations.js':allocationsURL,'../observability/prompt-memory.js':promptMemoryURL});
const phasesURL=await module('src/observability/phases.ts'),workerPhasesURL=await module('src/observability/browser-worker-observations.ts',{'./phases.js':phasesURL});
const browserPhasesURL=await module('src/observability/browser.ts',{'./phases.js':phasesURL,'./browser-worker-observations.js':workerPhasesURL,'./allocations.js':allocationsURL});
const modelMemoryURL=await module('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptMemoryURL});
const controlMemoryURL=await module('src/state/control-memory.ts',{'../observability/allocations.js':allocationsURL});
const documentListURL=await module('src/state/document-list.ts',{'../observability/model-memory.js':modelMemoryURL});
const shaURL=await module('src/protocol/sha256.ts'),displayProtocolURL=await module('src/protocol/display.ts'),displaySchedulerURL=await module('src/observability/display-scheduler.ts');
const displayTilesURL=await module('src/ui/display-tiles.ts',{'../observability/allocations.js':allocationsURL,'../observability/display-scheduler.js':displaySchedulerURL,'../protocol/display.js':displayProtocolURL,'../protocol/sha256.js':shaURL});
const {DocumentResources}=await import(resourcesURL),{DraftPersistence}=await import(draftURL);
const editorURL=await module('src/state/editor-client.ts',{
 '@en-reve/primitives/state/value.js':data('export function createValueModel(value){return {value:{get:()=>value},set:next=>{value=next;}}}'),
 './recovery-cache.js':data('export class RecoveryCache{};export class RecoveryPublicationConflict extends Error{}'),
 './recovery-client.js':data('export class RecoveryConsumer{}'),
 './browser-journal.js':data('export class BrowserJournal{}'),
 './draft-persistence.js':draftURL,'./document-lifecycle.js':resourcesURL,
 './control-memory.js':controlMemoryURL,'./document-list.js':documentListURL,'../observability/model-memory.js':modelMemoryURL,
 '../protocol/store.js':data('export const EMPTY_EXPECTED_VERSIONS={};'),
 '../protocol/sha256.js':shaURL,
 '../protocol/json.js':await module('src/protocol/json.ts'),
 '../protocol/validate.js':data('export const event=()=>{};'),
 '../observability/allocations.js':allocationsURL,'../observability/browser.js':browserPhasesURL});
const {EditorClient}=await import(editorURL),{CanvasView}=await import(await module('src/ui/canvas-view.ts',{'../observability/allocations.js':allocationsURL,'./display-tiles.js':displayTilesURL,'../observability/browser.js':browserPhasesURL}));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const draft={id:'draft',kind:'prompt',documentId:'document',targetLayerId:null,expectedDocumentRevision:'1',generation:'1',composing:false,text:'Retained unapplied prompt',savedGeneration:'1',pending:false,error:null};
function fixture(){
 const session={identity:()=> 'client',csrf:()=>'',transport:async()=>{throw Error('Unexpected network');}},editor=new EditorClient(session),owner=new DraftPersistence('ui',session.transport,session.csrf),document={id:'document',revision:'1',orderedLayerIds:[]};
 owner.checkpoint={uiSeq:'1',sessionId:'ui',drafts:[],preferences:{documentId:'document',selectedLayerIds:[]}};owner.drafts.set(draft.id,{...draft});editor.draftOwner=owner;editor.ui=owner.checkpoint;editor.patch({ready:true,document,documents:[document],history:[{id:'retained-history'}],review:{kind:'test'},selected:['layer'],download:{path:'retained-download'}});
 const calls=[];owner.restore=async()=>{calls.push('restore');return owner.checkpoint;};editor.flushDrafts=async()=>{calls.push('flush');};editor.preferences=async value=>{calls.push('preferences');owner.checkpoint.preferences={...owner.checkpoint.preferences,...value};};
 return {editor,owner,calls,document};
}
test('dispose invalidates synchronously but closes cache handles only after recovery drains',async()=>{
 const f=fixture(),gate=deferred();let canceled=0,closed=0;
 f.editor.consumer={cancel(){canceled++;},release(){return gate.promise;}};f.editor.cache={close(){closed++;}};f.editor.journal={close(){closed++;}};
 f.editor.dispose();assert.equal(canceled,1);assert.equal(closed,0);assert.equal(f.editor.view.ready,false);assert.equal(f.owner.drafts.size,0);
 gate.resolve();await f.editor.recoveryDrain;await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,2);
});
test('failed recovery cleanup remains visible and prevents premature cache close',async()=>{
 const f=fixture(),gate=deferred();let closed=0;
 f.editor.consumer={cancel(){},release(){return gate.promise;}};f.editor.cache={close(){closed++;}};f.editor.journal={close(){closed++;}};
 f.editor.dispose();gate.reject(Error('RECOVERY_RELEASE_UNCONFIRMED: reader'));await assert.rejects(f.editor.recoveryDrain,/RECOVERY_RELEASE_UNCONFIRMED/);await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,0);assert.match(f.editor.view.error,/RECOVERY_RELEASE_UNCONFIRMED/);
});
test('a queued old sync cannot begin a new recovery after disconnect invalidates its lifetime',async()=>{
 const f=fixture(),stream=deferred();let recoveries=0;
 f.editor.consumer={cancel(){},async release(){},async recover(){recoveries++;}};f.editor.streamTask=stream.promise;
 const syncing=f.editor.sync();f.editor.disconnect();stream.resolve();await syncing;await f.editor.recoveryDrain;assert.equal(recoveries,0);f.editor.dispose();
});
test('an explicit retry clears the prior drain failure only after the same consumer releases',async()=>{
 const f=fixture();let available=false,releases=0;f.editor.consumer={cancel(){},async release(){releases++;if(!available)throw Error('RECOVERY_RELEASE_UNCONFIRMED: reader');}};
 f.editor.disconnect();await assert.rejects(f.editor.recoveryDrain,/RECOVERY_RELEASE_UNCONFIRMED/);available=true;f.editor.disconnect();await f.editor.recoveryDrain;assert.equal(releases,2);assert.equal(f.editor.recoveryFailure,undefined);f.editor.dispose();
});
test('close saves before releasing consumers and retains durable history/jobs instead of cancelling',async()=>{
 const f=fixture(),gate=deferred();f.editor.patch({pending:[{label:'uncertain original operation'}]});let releases=0;
 f.editor.documentResources.register('test',{release:async()=>{assert.equal(f.editor.view.document,null);assert.equal(f.owner.checkpoint.preferences.documentId,null);releases++;await gate.promise;},inspect:()=>({handles:releases?0:1})});
 const close=f.editor.closeDocument();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(f.calls,['flush','restore','preferences']);assert.equal(f.owner.drafts.size,0);assert.equal(f.editor.view.documents.length,1);assert.equal(f.editor.view.pending[0].label,'uncertain original operation');assert.equal(f.editor.view.history.length,0);assert.equal(f.editor.view.review,null);assert.equal(f.editor.view.download,null);
 assert.equal(f.editor.documentResources.snapshot.releasing,true);assert.equal(f.editor.closeDocument(),close);gate.resolve();await close;assert.equal(releases,1);assert.equal(f.editor.documentResources.snapshot.releases,1);assert.equal(f.editor.documentResources.snapshot.releasing,false);
});
for(const boundary of ['flush','unsaved','preferences'])test('failed '+boundary+' keeps the current document and draft memory intact',async()=>{
 const f=fixture();let releases=0;f.editor.documentResources.register('test',{release:()=>{releases++;},inspect:()=>({})});
 if(boundary==='flush')f.editor.flushDrafts=async()=>{throw Error('STORAGE_FULL');};
 if(boundary==='unsaved')f.owner.drafts.get('draft').savedGeneration=null;
 if(boundary==='preferences')f.editor.preferences=async()=>{throw Error('UI_CONFLICT');};
 await assert.rejects(f.editor.closeDocument());assert.equal(f.editor.view.document,f.document);assert.equal(f.owner.drafts.get('draft').text,draft.text);assert.equal(releases,0);
});
test('stale close completion cannot close a replacement document',async()=>{
 const f=fixture(),gate=deferred();f.editor.flushDrafts=()=>gate.promise;const close=f.editor.closeDocument();f.editor.patch({document:{...f.document,id:'replacement'}});gate.resolve();await assert.rejects(close,/DOCUMENT_CHANGED/);assert.equal(f.editor.view.document.id,'replacement');assert.equal(f.owner.drafts.size,1);assert.deepEqual(f.calls,[]);
});
test('released draft restoration cannot resurrect text after close and same-document reopen can restore anew',async()=>{
 const f=fixture(),gate=deferred();f.owner.drafts.clear();f.owner.checkpoint.drafts=[{...draft,assetId:'caption',status:'saved-unapplied'}];const old=f.owner.restoreDraft('draft',()=>gate.promise);f.owner.releaseDocument('document');gate.resolve('late old text');await old;assert.equal(f.owner.drafts.size,0);await f.owner.restoreDraft('draft',async()=>draft.text);assert.equal(f.owner.drafts.get('draft').text,draft.text);
});
test('checkpoint response completing after release cannot undo the closed preference',async()=>{
 const gate=deferred(),owner=new DraftPersistence('ui',()=>gate.promise,()=>''),closed={sessionId:'ui',uiSeq:'2',preferences:{documentId:null},drafts:[]};owner.checkpoint=closed;
 const restore=owner.restore();owner.releaseDocument('document');gate.resolve(Response.json({...closed,uiSeq:'1',preferences:{documentId:'document'}}));await restore;assert.equal(owner.checkpoint,closed);
});
test('unmaterialized pending SaveDraft still prevents close until its original receipt is resolved',async()=>{
 const request={protocolVersion:1,requestId:'pending',sessionId:'ui',expectedUISeq:'1',body:{type:'SaveDraft',draft:{...draft,assetId:'retained-caption'}}};
 const owner=new DraftPersistence('ui',async()=>Response.json({sessionId:'ui',uiSeq:'1',preferences:{documentId:'document'},drafts:[]}),()=>'',{scan:async(_prefix,visit)=>{visit({request,draftId:'draft',generation:'1'});},put:async()=>{}});await owner.restore();assert.equal(owner.drafts.size,0);assert.throws(()=>owner.releaseDocument('document'),/Save the current drafts/);assert.deepEqual(owner.pendingRequests(),['pending']);owner.dispose();
});
for(const reopen of [false,true])test('history publication completing after close'+(reopen?' and same-document reopen':'')+' stays fenced',async()=>{
 const f=fixture(),gate=deferred();let reads=0;f.editor.cache={published:()=>++reads===1?Promise.resolve({generation:'g'}):gate.promise};f.editor.json=async()=>({items:[{id:'old-history'}],next:null});f.editor.session.transport=async()=>new Response(null,{headers:{'X-App-Entity-Version':'1'}});
 const history=f.editor.historyPage('history');await new Promise(resolve=>setImmediate(resolve));await f.editor.closeDocument();if(reopen)f.editor.patch({document:f.document});gate.resolve({generation:'g'});await history;assert.deepEqual(f.editor.view.history,[]);
});
test('open completing after disconnect cannot publish preferences for the abandoned connection',async()=>{
 const f=fixture(),gate=deferred();f.editor.loadDocument=()=>gate.promise;const open=f.editor.open('document');f.editor.disconnect();gate.resolve();await open;assert.deepEqual(f.calls,[]);
});
test('close aborts and settles an old general draft body before reporting resource release',async()=>{
 const f=fixture(),gate=deferred();f.owner.drafts.clear();f.owner.checkpoint.drafts=[{...draft,assetId:'caption',status:'saved-unapplied'}];let signal;
 f.editor.session.transport=async(_path,init)=>{signal=init.signal;return {ok:true,text:()=>gate.promise};};const read=f.editor.draftText('draft');await new Promise(resolve=>setImmediate(resolve));const close=f.editor.closeDocument();await new Promise(resolve=>setImmediate(resolve));assert.equal(signal.aborted,true);assert.equal(f.editor.documentResources.snapshot.releasing,true);gate.resolve('late retained body');assert.equal(await read,'');await close;assert.equal(f.owner.drafts.size,0);assert.deepEqual(f.editor.documentResources.snapshot.consumers['editor-client'],{uploads:0,draftReads:0});
});
test('resource failure does not skip other releases or publish a successful release receipt',async()=>{
 const resources=new DocumentResources();let released=0;resources.register('failed',{release:()=>{throw Error('termination failed');},inspect:()=>({handles:1})});resources.register('other',{release:()=>{released++;},inspect:()=>({handles:0})});await assert.rejects(resources.release(),AggregateError);assert.equal(released,1);assert.equal(resources.snapshot.releases,0);assert.equal(resources.snapshot.lastReleaseMilliseconds,null);
});
test('public Close retries failed owners after the document is durably closed without repeating draft writes',async()=>{
 const f=fixture(),retry=deferred();let failing=true,attempts=0,independent=0,retainedHandle=true;
 f.editor.documentResources.register('native-renderer',{release:async()=>{attempts++;if(failing)throw Error('TEXT_TERMINATION_FAILED');await retry.promise;retainedHandle=false;},inspect:()=>({handles:retainedHandle?1:0})});
 f.editor.documentResources.register('independent',{release:()=>{independent++;},inspect:()=>({handles:0})});
 await assert.rejects(f.editor.closeDocument(),/DOCUMENT_RESOURCE_RELEASE_FAILED/);assert.equal(f.editor.view.document,null);assert.equal(f.editor.documentResources.snapshot.failed,true);assert.equal(f.editor.documentResources.snapshot.releases,0);assert.equal(retainedHandle,true);assert.equal(independent,1);
 const durableCalls=[...f.calls];failing=false;const closing=f.editor.closeDocument();assert.equal(f.editor.closeDocument(),closing);await new Promise(resolve=>setImmediate(resolve));assert.equal(attempts,2);assert.equal(retainedHandle,true);assert.equal(f.editor.documentResources.snapshot.releasing,true);
 retry.resolve();await closing;assert.equal(retainedHandle,false);assert.equal(f.editor.documentResources.snapshot.failed,false);assert.equal(f.editor.documentResources.snapshot.releases,1);assert.equal(independent,2);assert.deepEqual(f.calls,durableCalls);
 await f.editor.closeDocument();assert.equal(attempts,2);assert.equal(independent,2);
});
function canvas(){const ctx=new Proxy({},{get:()=>()=>{}});return {addEventListener(){},width:800,height:600,dataset:{},getBoundingClientRect:()=>({width:800,height:600}),getContext:()=>ctx};}
const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const displayMetadata=()=>Response.json({projection:{value:{id:'asset',safety:'safe',availability:'available',raster:{width:20,height:20,pixelIdentity:digest('asset')}}}});
function displayPixels(){const bytes=new Uint8Array(20*20*4);return new Response(bytes,{headers:{'content-type':'application/x-ideogram-rgba8','content-length':String(bytes.length),etag:'"'+digest(bytes)+'"','X-Display-Profile':'cp1-display-v1','X-Display-Source':digest('asset'),'X-Display-Basis':'pixels','X-Display-Width':'20','X-Display-Height':'20','X-Display-Source-Width':'20','X-Display-Source-Height':'20','X-Display-LOD':'0'}});}
test('canvas close aborts owned fetch and does not create a late bitmap',{timeout:5000},async()=>{
 const gate=deferred(),entered=deferred();let signal,decodes=0;const previous=globalThis.createImageBitmap;globalThis.createImageBitmap=async()=>{decodes++;return {close(){}};};
 try{const view=new CanvasView(canvas(),async(_path,init)=>{signal=init.signal;entered.resolve();return gate.promise;});const show=view.show('asset',20,20);await entered.promise;const release=view.releaseDocument();assert.equal(signal.aborted,true);gate.resolve(displayMetadata());await Promise.all([show,release]);assert.equal(decodes,0);assert.equal(view.lifecycle.decodedBitmaps,0);assert.equal(view.lifecycle.pendingReads,0);assert.equal(view.decodedAssetId,null);}finally{globalThis.createImageBitmap=previous;}
});
test('canvas closes a late decoded bitmap exactly once and reopens the same asset',{timeout:5000},async()=>{
 const gate=deferred(),decodeStarted=deferred();let closes=0,decodes=0;const previous=globalThis.createImageBitmap,previousData=globalThis.ImageData;globalThis.ImageData=class{constructor(data,width,height){Object.assign(this,{data,width,height});}};globalThis.createImageBitmap=async()=>{decodes++;decodeStarted.resolve();return decodes===1?gate.promise:{width:20,height:20,close(){closes++;}};};
 // Close only after native tile decode begins; metadata completion alone is not
 // decoded residency. A reopened tile becomes ready after an actual draw call.
 try{const view=new CanvasView(canvas(),async path=>path.includes('/display-tile?')?displayPixels():displayMetadata()),show=view.show('asset',20,20);await decodeStarted.promise;assert.equal(decodes,1);const release=view.releaseDocument();gate.resolve({width:20,height:20,close(){closes++;}});await Promise.all([show,release]);assert.equal(closes,1);assert.equal(view.decodedAssetId,null);await view.show('asset',20,20);assert.equal(view.decodedAssetId,null);view.draw(1,0,0);assert.equal(view.decodedAssetId,'asset');await view.releaseDocument();assert.equal(closes,2);assert.equal(view.lifecycle.pendingReads,0);}finally{globalThis.createImageBitmap=previous;globalThis.ImageData=previousData;}
});
test('closed canvas redraw and resize callbacks cannot reallocate the viewport backing',()=>{const target=canvas(),view=new CanvasView(target,async()=>{throw Error('Unexpected read');});view.dispose();view.draw(1,0,0);assert.equal(target.width,1);assert.equal(target.height,1);assert.equal(view.lifecycle.canvasBytes,4);});


test('revising refused input back to the exact retained generation clears the close barrier',async()=>{
 const f=fixture();f.owner.refuseChange(draft.id,draft.documentId);assert.throws(()=>f.owner.assertDocumentSaved(draft.documentId),/workspace is full/);
 f.editor.changeDraft(draft.id,draft.kind,draft.text,draft.targetLayerId,draft.composing,draft.expectedDocumentRevision);
 assert.equal(f.owner.hasRefusedChanges,false);assert.equal(f.owner.drafts.get(draft.id).generation,draft.generation);assert.equal(f.owner.drafts.get(draft.id).savedGeneration,draft.savedGeneration);
 await f.editor.closeDocument();assert.equal(f.editor.view.document,null);assert.equal(f.owner.drafts.size,0);
});

test('a failed draft save admission can be retried after a smaller edit without an unrelated UI action',async()=>{
 const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL),posts=[],captions=[],loaded=[];
 const session={identity:()=> 'client',csrf:()=> 'csrf',transport:async(path,init)=>{
  assert.equal(path,'/api/v1/ui/ui');assert.equal(init.method,'POST');const request=JSON.parse(init.body);assert.equal(request.body.type,'SaveDraft');posts.push(request);
  return Response.json({protocolVersion:1,requestId:request.requestId,status:'accepted',uiSeq:String(posts.length)});
 }};
 const editor=new EditorClient(session),owner=new DraftPersistence('ui',session.transport,session.csrf),document={id:'document',revision:'1',orderedLayerIds:[]};
 owner.checkpoint={uiSeq:'0',sessionId:'ui',drafts:[],preferences:{documentId:document.id,selectedLayerIds:[]}};editor.draftOwner=owner;editor.ui=owner.checkpoint;assert.equal(editor.sessionId,'ui');editor.patch({ready:true,document,documents:[document]});
 editor.caption=async text=>{captions.push(text);return 'retained-caption';};editor.loadDocument=async value=>{loaded.push(value.id);};
 const large='retain this entire input '.repeat(32);owner.change({...draft,text:large});
 // Leave precisely the outgoing-generation pin available. The production
 // serialization/staging workspace then refuses before caption work starts.
 const pressure=allocationLedger.reserve({owner:'draft-retry-test-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes-large.length*2});
 try{
  await assert.rejects(editor.flushDrafts(),/PROMPT_MEMORY_BUDGET/);assert.deepEqual(posts,[]);assert.deepEqual(captions,[]);assert.equal(owner.drafts.get(draft.id).text,large);assert.equal(owner.drafts.get(draft.id).savedGeneration,null);
  pressure.release();editor.changeDraft(draft.id,draft.kind,'smaller corrected input',null,false,'1');await editor.flushDrafts();
  assert.deepEqual(captions,['smaller corrected input']);assert.deepEqual(loaded,[document.id]);assert.equal(posts.length,1);assert.equal(posts[0].body.draft.generation,'2');assert.equal(posts[0].body.draft.assetId,'retained-caption');
  assert.equal(owner.drafts.get(draft.id).savedGeneration,'2');assert.equal(owner.drafts.get(draft.id).error,null);assert.doesNotThrow(()=>owner.assertDocumentSaved(document.id));
 }finally{pressure.release();editor.dispose();}
});

test('late command completion cannot restart SSE while another command owns recovery',async()=>{
 const {editor}=fixture(),released=deferred(),recovered=deferred();let streams=0,recoveries=0,active=false;
 editor.cache={};editor.refresh=async()=>{};
 editor.consumer={
  release:()=>released.promise,
  async recover(){assert.equal(active,false);active=true;recoveries++;try{await recovered.promise;}finally{active=false;}},
  consumeStream(signal){assert.equal(active,false);active=true;streams++;return new Promise(resolve=>signal.addEventListener('abort',()=>{active=false;resolve();},{once:true}));}
 };
 const sync=editor.sync();
 try{
  // An older command can finish restoring drafts while sync awaits release.
  editor.startStream(editor.lifecycle);assert.equal(streams,0);
  released.resolve();for(let i=0;i<8;i++)await Promise.resolve();assert.equal(recoveries,1);
  editor.startStream(editor.lifecycle);assert.equal(streams,0);
  recovered.resolve();await sync;
  editor.startStream(editor.lifecycle);assert.equal(streams,1);
  editor.startStream(editor.lifecycle);assert.equal(streams,1);
 }finally{released.resolve();recovered.resolve();await sync;editor.stream?.abort();await editor.streamTask;}
});

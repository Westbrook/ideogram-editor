import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {allocationsURL,promptMemoryURL} from '../owned-preview-module.mjs';

const root=process.env.SHELL_STATE_ROOT??'.',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function moduleURL(path,imports={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const memoryURL=await moduleURL('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptMemoryURL});
const transformURL=await moduleURL(root+'/src/ui/inspector-transform.ts');
const inspectorURL=await moduleURL(root+'/src/ui/inspector-model.ts',{'../observability/model-memory.js':memoryURL,'../observability/allocations.js':allocationsURL,'../observability/prompt-memory.js':promptMemoryURL,'./inspector-transform.js':transformURL});
const renderURL=await moduleURL(root+'/src/ui/render-models.ts',{'../observability/allocations.js':allocationsURL});
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL),{cloneOwnedModel}=await import(memoryURL),{newInspector}=await import(inspectorURL),{RenderModelOwners}=await import(renderURL);
// Compile the actual shell class. Object.create skips browser-only field
// initializers; only editor/session and DOM boundary operations are controlled.
// The methods under test, restoredInspector and all model leases are real.
const compiled=(await transformWithOxc(await readFile(root+'/src/ui/shell.ts','utf8'),'shell.ts')).code;
const shellClass=compiled.slice(compiled.indexOf('class EditorShell'),compiled.lastIndexOf('scope.register('));
const shellModule=await import(data(`import {restoredInspector} from ${JSON.stringify(inspectorURL)};
class LitElement{};const nothing=null,scope={creationScope:{}};let editor,connection,clear=()=>{};
function html(strings,...values){return {strings:[...strings],values};}
function renderInto(_value,root){clear(root);}
export function bind(client,session={}){editor=client;connection=session;}
export function setClear(work){clear=work;}
${shellClass}
export {EditorShell};`));
const totals=()=>{const value=allocationLedger.snapshot();return {cpu:value.cpuBytes,gpu:value.gpuBytes,handles:value.handles,records:value.activeRecords};};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function tracked(model){let pins=0,releases=0;return {value:model.value,release(){releases++;model.release();},pin(){const drop=model.pin();pins++;let live=true;return ()=>{if(live){live=false;pins--;drop();}};},get pins(){return pins;},get releases(){return releases;}};}
const alive=model=>{const unpin=model.pin();unpin();},released=model=>assert.throws(()=>model.pin(),/MODEL_MEMORY_RELEASED/);
const layer={id:'layer',version:'1',kind:'image',name:'Accepted name',locked:false,assetId:'asset',appearanceDescription:'',opacity:1,visible:true,layerToDocument:[1,0,0,1,0,0]};
function restoreFixture(options={}){
 const before=totals(),initial=tracked(newInspector(layer,{id:'document',revision:'8'},'inspector-document-layer'));
 const saved={id:'saved-inspector',kind:'inspector',documentId:'document',targetLayerId:'layer',status:'saved-unapplied',expectedDocumentRevision:'5',generation:'3'};
 const checkpoint=tracked(cloneOwnedModel('shell-checkpoint',{sessionId:'ui',uiSeq:'1',drafts:[saved]}));let current=checkpoint;
 const text=tracked(cloneOwnedModel('shell-draft-text',options.text??JSON.stringify({...initial.value.values,name:'Unapplied name'}))),gate=deferred(),patches=[],started=[];
 let reads=0,writes=0,updates=0;
 const editor={get ui(){return current?.value;},pinUI(){if(options.pinUIFail)throw Error('checkpoint pin failed');return current?.pin()??(()=>{});},ownedDraftText(id){assert.equal(id,saved.id);reads++;return gate.promise;},patch(value){patches.push(value);}};
 shellModule.bind(editor);
 const shell=Object.create(shellModule.EditorShell.prototype);
 Object.assign(shell,{fieldsOwner:initial,inspectorFieldsGeneration:1,inspectorKey:'document:layer',writeFields(){writes++;assert.equal(checkpoint.pins,1);assert.equal(initial.pins,1);alive(text);},requestUpdate(){updates++;}});
 return {before,shell,editor,initial,checkpoint,text,gate,patches,restore(key){const work=shell.restoreInspectorOwned(key);started.push(work);void work.catch(()=>{});return work;},get reads(){return reads;},get writes(){return writes;},get updates(){return updates;},replaceCheckpoint(){const next=tracked(cloneOwnedModel('shell-checkpoint',{sessionId:'ui',uiSeq:'2',drafts:[{...saved,generation:'4',expectedDocumentRevision:'8'}]}));current=next;checkpoint.release();return next;},async cleanup(){gate.resolve(text);await Promise.allSettled(started);shell.setFields();current?.release();checkpoint.release();text.release();assert.deepEqual(totals(),before);}};
}

test('actual inspector restore holds checkpoint and returned text through independent model admission',async()=>{
 const f=restoreFixture();try{
  const work=f.restore('document:layer');assert.equal(f.reads,1);assert.equal(f.initial.pins,1);assert.equal(f.checkpoint.pins,1);assert.equal(f.text.releases,0);
  f.gate.resolve(f.text);await work;
  assert.equal(f.shell.fields.values.name,'Unapplied name');assert.equal(f.shell.fields.document.revision,'5');assert.equal(f.shell.fields.draftId,'saved-inspector');assert.equal(f.writes,1);assert.equal(f.patches.length,1);
  assert.equal(f.checkpoint.pins,0);assert.equal(f.initial.pins,0);released(f.initial);released(f.text);
 }finally{await f.cleanup();}
});
test('a replaced checkpoint cannot restore old metadata even with the same inspector key and generation',async()=>{
 const f=restoreFixture();try{
  const work=f.restore('document:layer');f.replaceCheckpoint();alive(f.checkpoint);assert.equal(f.checkpoint.pins,1);
  f.gate.resolve(f.text);await work;assert.equal(f.shell.fieldsOwner,f.initial);assert.equal(f.shell.fields.values.name,'Accepted name');assert.equal(f.writes,0);assert.equal(f.patches.length,0);released(f.checkpoint);released(f.text);assert.equal(f.initial.pins,0);
 }finally{await f.cleanup();}
});
for(const fence of ['key','generation','dirty','removed'])test('stale inspector '+fence+' refuses publication and releases actual borrowed owners',async()=>{
 const f=restoreFixture();try{
  const work=f.restore('document:layer');
  if(fence==='key')f.shell.inspectorKey='document:other';else if(fence==='generation')f.shell.inspectorFieldsGeneration++;else if(fence==='dirty')f.initial.value.dirty=true;else f.shell.setFields();
  f.gate.resolve(f.text);await work;assert.equal(f.writes,0);assert.equal(f.patches.length,0);assert.equal(f.initial.pins,0);assert.equal(f.checkpoint.pins,0);released(f.text);
 }finally{await f.cleanup();}
});
test('checkpoint pin failure rolls back the preceding inspector pin without starting a text read',async()=>{
 const f=restoreFixture({pinUIFail:true});try{await assert.rejects(f.restore('document:layer'),/checkpoint pin failed/);assert.equal(f.reads,0);assert.equal(f.initial.pins,0);assert.equal(f.checkpoint.pins,0);f.initial.release();released(f.initial);}finally{await f.cleanup();}
});
for(const text of ['{','{}'])test('malformed saved inspector '+JSON.stringify(text)+' releases text and checkpoint without replacing fields',async()=>{
 const f=restoreFixture({text});try{const work=f.restore('document:layer');f.gate.resolve(f.text);await assert.rejects(work);assert.equal(f.shell.fieldsOwner,f.initial);assert.equal(f.writes,0);assert.equal(f.initial.pins,0);assert.equal(f.checkpoint.pins,0);released(f.text);}finally{await f.cleanup();}
});
test('inspector admission refusal preserves fields and releases the actual parsed-input owner',async()=>{
 const f=restoreFixture();let pressure;try{
  const work=f.restore('document:layer'),snapshot=allocationLedger.snapshot();
  pressure=allocationLedger.reserve({owner:'shell-restore-pressure',kind:'scratch',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-(snapshot.cpuBytes-snapshot.text.ownedReservationBytes)});
  f.gate.resolve(f.text);await assert.rejects(work,/ALLOCATION_BUDGET/);assert.equal(f.shell.fieldsOwner,f.initial);assert.equal(f.writes,0);assert.equal(f.initial.pins,0);assert.equal(f.checkpoint.pins,0);released(f.text);
 }finally{pressure?.release();await f.cleanup();}
});
test('a rejected owned text read releases both preexisting inspector and checkpoint borrows',async()=>{
 const f=restoreFixture();try{const work=f.restore('document:layer');f.gate.reject(Error('DRAFT_UNAVAILABLE'));await assert.rejects(work,/DRAFT_UNAVAILABLE/);assert.equal(f.initial.pins,0);assert.equal(f.checkpoint.pins,0);assert.equal(f.shell.fieldsOwner,f.initial);}finally{await f.cleanup();}
});

function renderState(prefix){
 const models=[],roots=new Map(),make=(name,value)=>{const model=cloneOwnedModel('shell-render-state',{[name]:value});models.push(model);roots.set(model.value[name],model);return model.value[name];};
 const view={download:make('download',{name:prefix}),image:make('image',{layers:[]}),save:make('save',{name:prefix}),document:make('document',{id:prefix}),documents:make('documents',[{id:prefix+'-listed'}]),history:make('history',[{id:prefix+'-history'}]),checkpoints:make('checkpoints',[{id:prefix+'-checkpoint'}]),review:make('review',{id:prefix+'-review'}),uiChoices:make('uiChoices',[{sessionId:prefix,uiSeq:'1'}]),stages:make('stages',[{stagingId:prefix}]),pending:make('pending',[{id:prefix}]),ready:true,busy:false};
 roots.set(view.documents[0],roots.get(view.documents));
 const checkpoint=cloneOwnedModel('shell-render-checkpoint',{sessionId:prefix,drafts:[]}),capability=cloneOwnedModel('shell-render-capability',{protocolVersion:1,profiles:[prefix]}),fields=cloneOwnedModel('shell-render-fields',{name:prefix}),rasterize=cloneOwnedModel('shell-render-rasterize',{name:prefix}),metadata=cloneOwnedModel('shell-render-metadata',{selected:[],uiPending:[],message:prefix,error:'',recovery:'',drafts:'',cursor:'0',historyNext:null,checkpointNext:null,uiNext:null,stageNext:null,pendingAfter:null,pendingDirection:'next',pendingPrevious:null,pendingNext:null,pendingCreate:false,ready:true,busy:false,undoAvailable:null});Object.assign(view,metadata.value);models.push(checkpoint,capability,fields,rasterize,metadata);
 let seen;
 const editor={navigationControlsRendered(){},renderViewMetadata(value){assert.equal(value,view,'The exact captured editor view owns its metadata');return metadata;},renderViewModels(...values){seen=values;const unique=new Map();for(const value of values){if(!value)continue;const model=roots.get(value);if(!model)throw Error('VIEW_MODEL_UNOWNED');unique.set(model.value,model);}return [...unique.values()];},renderUI(){return [checkpoint];}};
 const snapshot={view,session:{capabilities:capability.value}};
 const connection={renderCapabilities(value){assert.equal(value,snapshot.session.capabilities,'The captured session projection is the render source');return value?[capability]:[];}};
 return {models,view,snapshot,editor,connection,fields,rasterize,checkpoint,capability,get seen(){return seen;},release(){for(const model of models)model.release();}};
}
test('actual shell render pins all sixteen roots including metadata, session, checkpoint, review and list projections until commit and clear',()=>{
 const before=totals(),shell=Object.create(shellModule.EditorShell.prototype),owners=new RenderModelOwners(),stop=Error('render boundary'),first=renderState('first'),second=renderState('second');
 Object.assign(shell,{isConnected:true,renderModelOwners:owners,requestNode:'request',inspectorNode:'inspector',renderRoot:'main',renderPanes(){throw stop;}});
 const render=state=>{shellModule.bind(state.editor,state.connection);Object.assign(shell,{read:{snapshot:state.snapshot},fieldsOwner:state.fields,rasterizeOwner:state.rasterize});assert.throws(()=>shell.render(),error=>error===stop);assert(state.seen.includes(state.view.review));for(const name of ['uiChoices','stages','pending'])assert(state.seen.includes(state.view[name]));};
 try{
  render(first);assert.equal(owners.ownership.roots,16);owners.commit();first.release();for(const model of first.models)alive(model);
  render(second);second.release();assert.equal(owners.ownership.roots,32);assert.equal(owners.ownership.pending,true);for(const model of first.models)alive(model);
  owners.commit();assert.equal(owners.ownership.roots,16);for(const model of first.models)released(model);for(const model of second.models)alive(model);
  const cleared=[];shellModule.setClear(root=>cleared.push(root));shell.clearRenderedModels();assert.deepEqual(cleared,['request','inspector','main']);for(const model of second.models)released(model);assert.deepEqual(totals(),before);
 }finally{owners.clear();first.release();second.release();shellModule.setClear(()=>{});}
});
test('an unavailable captured capability cannot silently borrow a different current session root',()=>{
 const before=totals(),state=renderState('captured'),owners=new RenderModelOwners(),shell=Object.create(shellModule.EditorShell.prototype);state.capability.release();
 shellModule.bind(state.editor,state.connection);Object.assign(shell,{isConnected:true,renderModelOwners:owners,read:{snapshot:state.snapshot},fieldsOwner:state.fields,rasterizeOwner:state.rasterize,renderPanes(){assert.fail('A missing root must refuse before rendering');}});
 try{assert.throws(()=>shell.render(),/MODEL_MEMORY_RELEASED/);assert.equal(owners.ownership.roots,0);assert.equal(owners.ownership.pending,false);}finally{owners.clear();state.release();assert.deepEqual(totals(),before);}
});

function findTemplate(value,predicate){if(!value||typeof value!=='object')return;if(value.strings&&predicate(value.strings.join('')))return value;for(const child of Array.isArray(value)?value:value.values??[]){const found=findTemplate(child,predicate);if(found)return found;}}
function dialogShell(editor,connection={identity:()=> 'client'}){const shell=Object.create(shellModule.EditorShell.prototype);let queued;Object.assign(shell,{panel:'open',action(_event,_label,work){queued=work;},closePanel(){this.panel=null;}});shellModule.bind(editor,connection);return {shell,get queued(){return queued;}};}
test('saved checkpoint callbacks resolve their scalar identity on the current inventory before dispatch',async()=>{
 const before=totals(),old=cloneOwnedModel('shell-choice',[{sessionId:'session',uiSeq:'1',documentId:'document'}]),next=cloneOwnedModel('shell-choice',[{sessionId:'session',uiSeq:'1',documentId:'document'}]),gate=deferred();let pinned=0,received;
 const editor={view:{document:null,review:null,documents:[],stages:[],uiChoices:old.value},restoreUI(choice){assert.equal(choice,next.value[0]);const unpin=next.pin();pinned++;received=choice;return gate.promise.finally(()=>{unpin();pinned--;});}};
 const f=dialogShell(editor);let work;
 try{const template=findTemplate(f.shell.dialogs(),value=>value.includes('>Restore ')&&value.includes('sequence'));assert(template);template.values.find(value=>typeof value==='function')({});old.release();editor.view.uiChoices=next.value;
  work=f.queued();void work.catch(()=>{});assert.equal(received,next.value[0]);assert.equal(pinned,1);next.release();alive(next);gate.resolve();await work;assert.equal(pinned,0);released(next);released(old);assert.equal(f.shell.panel,null);
 }finally{gate.resolve();await Promise.allSettled(work?[work]:[]);old.release();next.release();assert.deepEqual(totals(),before);}
});
test('a saved checkpoint callback refuses a replaced inventory sequence without dispatch',async()=>{
 const before=totals(),old=cloneOwnedModel('shell-choice',[{sessionId:'session',uiSeq:'1',documentId:'document'}]);let calls=0;
 const editor={view:{document:null,review:null,documents:[],stages:[],uiChoices:old.value},restoreUI(){calls++;}};
 const f=dialogShell(editor);
 try{const template=findTemplate(f.shell.dialogs(),value=>value.includes('>Restore ')&&value.includes('sequence'));assert(template);template.values.find(value=>typeof value==='function')({});old.release();editor.view.uiChoices=[];
  await assert.rejects(f.queued(),/saved UI checkpoint changed/);assert.equal(calls,0);assert.equal(f.shell.panel,'open');released(old);
 }finally{old.release();assert.deepEqual(totals(),before);}
});
for(const purpose of ['image','bundle'])test('retired '+purpose+' transfer callbacks use staging identity scalars',async()=>{
 const before=totals(),stage=cloneOwnedModel('shell-transfer-row',[{stagingId:'stage',purpose,ownerClientId:'client',committedOffset:'0',expectedBytes:'1',state:'open'}]),row=stage.value[0],file={name:'fixture'},seen=[];let pending;
 const editor={view:{document:null,review:null,documents:[],stages:stage.value,uiChoices:[]},run(_label,work){pending=Promise.resolve().then(work);return pending;},resumeStage(value,id){seen.push(['bundle',value,id]);},fail(error){throw error;}};
 const f=dialogShell(editor);Object.assign(f.shell,{adapter:{settled(_event,read,work){work(read());}},resumeImage(value,id){seen.push(['image',value,id]);return Promise.resolve();},prepare(work){return Promise.resolve(work());}});
 try{const template=findTemplate(f.shell.dialogs(),value=>value.includes('choose-label="Reselect exact original"'));assert(template);const callback=template.values.find(value=>typeof value==='function');
  stage.release();editor.view.stages=[];
  // A stale graph read is a test fault. The already-rendered callback has only
  // the two scalar identifiers and never needs the retired inventory row.
  for(const key of ['stagingId','purpose'])Object.defineProperty(row,key,{get(){throw Error('retired stage graph read');}});
  callback({currentTarget:{files:[file]}});await pending;assert.deepEqual(seen,[[purpose,file,'stage']]);released(stage);
 }finally{await Promise.allSettled(pending?[pending]:[]);stage.release();assert.deepEqual(totals(),before);}
});

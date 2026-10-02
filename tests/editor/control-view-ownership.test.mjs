// Source-authored only. Real owners/ledger; browser rendering and cache IO are
// explicit boundaries. These fixtures are not physical-memory qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {allocationsURL,promptMemoryURL} from '../owned-preview-module.mjs';
import {viewModelDependencies} from '../view-model-module.mjs';
const root=process.env.CLIENT_METADATA_ROOT??'.';
const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
async function moduleURL(path,imports={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const {viewURL,memoryURL,controlURL}=await viewModelDependencies(allocationsURL,{root,promptURL:promptMemoryURL});
const renderURL=await moduleURL(root+'/src/ui/render-models.ts',{'../observability/allocations.js':allocationsURL});
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL),{cloneOwnedModel,modelPayloadBytes}=await import(memoryURL);
await import(controlURL);
const total=()=>{const value=allocationLedger.snapshot();return {cpu:value.cpuBytes,handles:value.handles,records:value.activeRecords};};
// Observe the actual first module evaluation. Later fixture baselines include
// this service root; they must never mistake its lifetime for a client leak.
const beforeViewModule=total();
const {ViewModelOwners,EDITOR_METADATA_LIMITS}=await import(viewURL),afterViewModule=total();
const {RenderModelOwners}=await import(renderURL);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const value=patch=>({selected:[],uiPending:[],message:'Ready',error:'',recovery:'',drafts:'',cursor:'0',historyNext:null,checkpointNext:null,uiNext:null,stageNext:null,pendingAfter:null,pendingDirection:'next',pendingPrevious:null,pendingNext:null,pendingCreate:false,ready:true,busy:false,undoAvailable:null,...patch});
function fixture(){const before=total(),owners=new ViewModelOwners();let current;const publish=input=>owners.publishControlView(input,next=>{current=next;});return {before,owners,publish,get current(){return current;},close(){owners.releaseControlView();assert.deepEqual(total(),before);}};}
const clearedView=()=>value({ready:false,busy:false,message:'',documents:[],document:null,image:null,history:[],checkpoints:[],review:null,download:null,save:null,pending:[],uiChoices:[],stages:[]});
function assertDeepFrozen(value){if(value&&typeof value==='object'){assert(Object.isFrozen(value));for(const child of Object.values(value))assertDeepFrozen(child);}}

test('the terminal view is one preexisting real model booking for the module lifetime',async()=>{
 const terminal=new ViewModelOwners().terminalView(),payload=modelPayloadBytes(terminal),before=total();
 assert(payload>0&&payload<=1024);assert.deepEqual(afterViewModule,{cpu:beforeViewModule.cpu+payload,handles:beforeViewModule.handles+1,records:beforeViewModule.records+1});
 assert.deepEqual(terminal,clearedView());assertDeepFrozen(terminal);
 const again=await import(viewURL);for(let n=0;n<32;n++){const owner=new again.ViewModelOwners();assert.equal(owner.terminalView(),terminal);owner.releaseControlView();}
 assert.deepEqual(total(),before);assert.throws(()=>terminal.selected.push('late'),TypeError);assert.throws(()=>{terminal.message='late';},TypeError);
});

test('control views own independent immutable selected/pending payloads without cloning document roots',()=>{
 const f=fixture(),selected=['layer'],pending=['request'],document={name:'retained elsewhere'};try{f.publish(value({selected,uiPending:pending,document}));selected.push('later');pending[0]='changed';assert.deepEqual(f.current.selected,['layer']);assert.deepEqual(f.current.uiPending,['request']);assert.equal(f.current.document,document);assert(Object.isFrozen(f.current.selected));assert(total().cpu>f.before.cpu);}finally{f.close();}
});
test('unchanged control metadata reuses its exact owner across unrelated document publication',()=>{
 const f=fixture();try{f.publish(value());const prior=f.owners.renderControlView(f.current),held=total();f.publish({...f.current,document:{id:'new'}});assert.equal(f.owners.renderControlView(f.current).value,prior.value);assert.deepEqual(total(),held);}finally{f.close();}
});
test('prospective budget refusal preserves the complete current control view',()=>{
 const f=fixture();let pressure;try{f.publish(value({selected:['accepted']}));const prior=f.current,held=allocationLedger.snapshot();pressure=allocationLedger.reserve({owner:'metadata-test-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-(held.cpuBytes-held.text.ownedReservationBytes)});assert.throws(()=>f.publish(value({selected:['replacement']})),/ALLOCATION_BUDGET/);assert.equal(f.current,prior);const unpin=f.owners.renderControlView(prior).pin();unpin();}finally{pressure?.release();f.close();}
});
test('failed publication retains the previous metadata owner and refunds the candidate',()=>{
 const f=fixture();try{f.publish(value());const prior=f.current,held=total();assert.throws(()=>f.owners.publishControlView(value({message:'next'}),()=>{throw Error('publication failed');}),/publication failed/);assert.equal(f.current,prior);const unpin=f.owners.renderControlView(prior).pin();unpin();assert.deepEqual(total(),held);}finally{f.close();}
});
test('actual render pins keep replaced control payloads until successful commit',()=>{
 const f=fixture(),render=new RenderModelOwners();try{f.publish(value({selected:['old'],message:'old'}));const old=f.owners.renderControlView(f.current);render.begin([old]);render.commit();f.publish(value({selected:['new'],message:'new'}));const next=f.owners.renderControlView(f.current);render.begin([next]);const unpin=old.pin();unpin();assert.equal(f.owners.ownership.retiredPinnedRoots,1);render.commit();assert.throws(()=>old.pin(),/RELEASED|UNOWNED/);assert.equal(f.owners.ownership.retiredPinnedRoots,0);}finally{render.clear();f.close();}
});
test('failed render and root disposal retain actual metadata until explicit native-root clearing',()=>{
 const f=fixture(),render=new RenderModelOwners();try{f.publish(value());const prior=f.owners.renderControlView(f.current);render.begin([prior]);f.owners.releaseControlView();assert(total().cpu>f.before.cpu);const unpin=prior.pin();unpin();render.clear();assert.throws(()=>prior.pin(),/RELEASED|UNOWNED/);}finally{render.clear();f.close();}
});
test('retired control roots are bounded and refusal cannot silently release concrete action pins',()=>{
 const f=fixture(),pins=[];try{f.publish(value());for(let n=0;n<EDITOR_METADATA_LIMITS.retiredRoots;n++){pins.push(f.owners.renderControlView(f.current).pin());f.publish(value({message:String(n)}));}const prior=f.current;assert.throws(()=>f.publish(value({message:'over limit'})),/RETIREMENT_LIMIT/);assert.equal(f.current,prior);assert.equal(f.owners.ownership.retiredPinnedRoots,EDITOR_METADATA_LIMITS.retiredRoots);}finally{for(const release of pins)release();f.close();}
});
test('oversized metadata refuses without replacing selection or status',()=>{
 const f=fixture();try{f.publish(value());const prior=f.current;assert.throws(()=>f.publish(value({selected:Array(EDITOR_METADATA_LIMITS.selected+1).fill('id')})),/METADATA_LIMIT/);assert.throws(()=>f.publish(value({error:'x'.repeat(EDITOR_METADATA_LIMITS.textUnits+1)})),/METADATA_LIMIT/);assert.equal(f.current,prior);}finally{f.close();}
});
test('pending page cursors and the global creation flag remain bounded owned metadata through refusal and render replacement',()=>{
 const f=fixture(),cursor='command:'+'x'.repeat(248);let pin;
 try{f.publish(value({pendingNext:cursor,pendingCreate:true}));const prior=f.current,model=f.owners.renderControlView(prior);pin=model.pin();
  for(const patch of [{pendingNext:cursor+'x'},{pendingAfter:'ui-request:foreign'},{pendingPrevious:'command:'},{pendingDirection:'sideways'},{pendingCreate:'true'}]){assert.throws(()=>f.publish({...prior,...patch}),/EDITOR_METADATA/);assert.equal(f.current,prior);}
  f.publish(value({pendingAfter:'command:031',pendingPrevious:'command:032',pendingCreate:false}));assert.equal(f.owners.ownership.retiredPinnedRoots,1);assert.equal(model.value.pendingNext,cursor);assert.equal(model.value.pendingCreate,true);assert.equal(f.current.pendingPrevious,'command:032');assert.equal(f.current.pendingCreate,false);pin();pin=undefined;assert.equal(f.owners.ownership.retiredPinnedRoots,0);assert.throws(()=>model.pin(),/RELEASED|UNOWNED/);
 }finally{pin?.();f.close();}
});
test('document validation preadmits its independent clone and retains it across late completion',async()=>{
 const before=total(),owners=new ViewModelOwners(),gate=deferred();let current=true,reads=0;const work=owners.validateDocumentRead({read:async()=>{reads++;assert(total().cpu-before.cpu>=EDITOR_METADATA_LIMITS.documentReadBytes);return gate.promise;}},{id:'doc',revision:'2'},()=>current);assert.equal(reads,1);current=false;assert(total().cpu>before.cpu);gate.resolve({id:'doc',revision:'2'});assert.equal(await work,false);assert.deepEqual(total(),before);
});
test('document-read admission refusal happens before the native request',async()=>{
 const before=total(),owners=new ViewModelOwners(),s=allocationLedger.snapshot(),pressure=allocationLedger.reserve({owner:'metadata-test-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-(s.cpuBytes-s.text.ownedReservationBytes)});let reads=0;try{await assert.rejects(owners.validateDocumentRead({read:async()=>{reads++;return null;}},{id:'doc',revision:'1'},()=>true),/ALLOCATION_BUDGET/);assert.equal(reads,0);}finally{pressure.release();}assert.deepEqual(total(),before);
});
test('document validation rejects oversized legacy logical payload without certifying native cloning',async()=>{
 const before=total(),owners=new ViewModelOwners();for(const row of [{id:'doc',revision:'1',name:'x'.repeat(65536)},{id:'doc',revision:'1',['k'.repeat(150000)]:undefined}])await assert.rejects(owners.validateDocumentRead({read:async()=>row},{id:'doc',revision:'1'},()=>true),/DOCUMENT_VALIDATION_MODEL_LIMIT/);assert.deepEqual(total(),before);assert.equal(allocationLedger.snapshot().complete,false);
});
test('document validation checks exact identity and drains rejection and absent-row paths',async()=>{
 const before=total(),owners=new ViewModelOwners(),document={id:'doc',revision:'1'};for(const result of [undefined,null,{id:'other',revision:'1'},{id:'doc',revision:'2'}])assert.equal(await owners.validateDocumentRead({read:async()=>result},document,()=>true),false);assert.equal(await owners.validateDocumentRead({read:async()=>({...document})},document,()=>true),true);await assert.rejects(owners.validateDocumentRead({read:async()=>{throw Error('IDB failure');}},document,()=>true),/IDB failure/);assert.deepEqual(total(),before);
});

// Invoke the real EditorClient methods without unrelated connection/native
// constructor setup. The queue, envelope admission and metadata owner are real.
const clientSource=(await transformWithOxc(await readFile(root+'/src/state/editor-client.ts','utf8'),'editor-client.ts')).code.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];?\n/gm,'');
const {EditorClient}=await import(data(`import {reserveCommandWire,measureControl} from ${JSON.stringify(controlURL)};import {cloneOwnedModel} from ${JSON.stringify(memoryURL)};const browserPhases={resetNavigation(){},reset(){}};${clientSource}`));
function clientFixture(){
 const before=total(),client=Object.create(EditorClient.prototype),owners=new ViewModelOwners();let view=value({...clearedView(),ready:true,busy:true,message:'Active',selected:['layer'],uiPending:['request']}),publication;
 Object.assign(client,{viewModels:owners,state:{value:{get:()=>view},set:next=>{publication?.(next);view=next;}},lifecycle:0,pendingRead:0,recoveryDrain:Promise.resolve(),retiredDraftOwners:new Set(),draftOwnerDrains:new Map(),viewReads:{release:async()=>{}},controlReads:{release:async()=>{}},session:{}});
 return {before,client,owners,get view(){return view;},onPublication(callback){publication=callback;},async close(){publication=undefined;client.dispose();await client.recoveryDrain;assert.deepEqual(total(),before);}};
}
function fillLedger(){const s=allocationLedger.snapshot();return allocationLedger.reserve({owner:'metadata-test-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-(s.cpuBytes-s.text.ownedReservationBytes)});}
// Observe every attempted admission while delegating to the actual ledger.
// No accepted allocation, refusal, or lease behavior is replaced by a stub.
function observeAdmissions(work){const own=Object.getOwnPropertyDescriptor(allocationLedger,'reserve'),reserve=allocationLedger.reserve,owners=[];allocationLedger.reserve=function(value){owners.push(value.owner);return reserve.call(this,value);};try{work();return owners;}finally{if(own)Object.defineProperty(allocationLedger,'reserve',own);else delete allocationLedger.reserve;}}

test('multiple actual clients publish the same deeply frozen cleared terminal view',async()=>{
 const a=clientFixture(),b=clientFixture(),terminal=a.owners.terminalView();
 try{
  a.client.mountViewMetadata();b.client.mountViewMetadata();assert.notEqual(a.view,b.view);
  a.client.dispose();b.client.dispose();await Promise.all([a.client.recoveryDrain,b.client.recoveryDrain]);
  assert.equal(a.view,terminal);assert.equal(b.view,terminal);assert.deepEqual(terminal,clearedView());assertDeepFrozen(terminal);assert.deepEqual(total(),a.before);
  assert.throws(()=>a.client.renderViewMetadata(terminal),/UNOWNED/);assert.throws(()=>b.client.renderViewMetadata(terminal),/UNOWNED/);
  assert.deepEqual(observeAdmissions(()=>{a.client.dispose();b.client.dispose();}),[]);assert.equal(a.view,b.view);assert.deepEqual(total(),a.before);
 }finally{await a.close();await b.close();}
});

test('many actual dispose and remount cycles retain only the one terminal service root',async()=>{
 const f=clientFixture(),render=new RenderModelOwners(),terminal=f.owners.terminalView();
 try{for(let n=0;n<32;n++){
  f.client.mountViewMetadata();assert.notEqual(f.view,terminal);const old=f.client.renderViewMetadata(f.view);render.begin([old]);render.commit();render.clear();
  f.client.dispose();await f.client.recoveryDrain;assert.equal(f.view,terminal);assert.deepEqual(total(),f.before);assert.equal(f.owners.ownership.currentRoots,0);assert.equal(f.owners.ownership.retiredPinnedRoots,0);assert.throws(()=>old.pin(),/RELEASED|UNOWNED/);
 }}finally{render.clear();await f.close();}
});

test('full-budget disposal makes no admission and a refused remount keeps the terminal service owned',async()=>{
 const f=clientFixture(),terminal=f.owners.terminalView();let pressure;
 try{
  f.client.mountViewMetadata();const old=f.client.renderViewMetadata(f.view);pressure=fillLedger();const refusals=allocationLedger.snapshot().refusals;
  assert.deepEqual(observeAdmissions(()=>f.client.dispose()),[]);await f.client.recoveryDrain;assert.equal(f.view,terminal);assert.equal(allocationLedger.snapshot().refusals,refusals);assert.throws(()=>old.pin(),/RELEASED|UNOWNED/);
  pressure.release();pressure=undefined;assert.deepEqual(total(),f.before);
  pressure=fillLedger();const full=total();assert.throws(()=>f.client.mountViewMetadata(),/ALLOCATION_BUDGET/);assert.equal(f.view,terminal);assert.deepEqual(total(),full);assert.throws(()=>f.client.renderViewMetadata(terminal),/UNOWNED/);
  assert.deepEqual(observeAdmissions(()=>f.client.dispose()),[]);assert.equal(f.owners.terminalView(),terminal);pressure.release();pressure=undefined;assert.deepEqual(total(),f.before);
  f.client.mountViewMetadata();assert.notEqual(f.view,terminal);assert.equal(f.owners.ownership.currentRoots,1);
 }finally{pressure?.release();await f.close();}
});

test('actual disposal keeps an old rendered control owner until its last render pin clears',async()=>{
 const f=clientFixture(),render=new RenderModelOwners();
 try{
  f.client.mountViewMetadata();const old=f.client.renderViewMetadata(f.view);render.begin([old]);render.commit();const held=total();
  f.client.dispose();await f.client.recoveryDrain;assert.equal(f.view,f.owners.terminalView());assert.deepEqual(total(),held);assert.equal(f.owners.ownership.currentRoots,0);assert.equal(f.owners.ownership.retiredPinnedRoots,1);assert.equal(render.ownership.roots,1);
  const release=old.pin();release();render.clear();assert.throws(()=>old.pin(),/RELEASED|UNOWNED/);assert.equal(f.owners.ownership.retiredPinnedRoots,0);assert.deepEqual(total(),f.before);
 }finally{render.clear();await f.close();}
});

test('a refused terminal publication preserves prior model, document, and control owners',async()=>{
 const f=clientFixture(),documents=cloneOwnedModel('terminal-test-documents',[{id:'doc',revision:'1'}]),review=cloneOwnedModel('terminal-test-review',{kind:'edit',review:{id:'review'}}),documentOwner={documents:documents.value,pin:()=>documents.pin(),release:()=>documents.release()},failure=Error('terminal publication refused');
 try{
  f.client.documentsMetadata=documentOwner;f.client.mountViewMetadata();
  f.owners.publish([{slot:'review',model:review,identity:'terminal-test-review',exposed:review.value,references:function*(){yield review.value;}}],()=>f.client.patch({document:documents.value[0],review:review.value}));
  const prior=f.view,control=f.client.renderViewMetadata(prior),selectedPin=f.client.selectedDocumentPin,held=total();assert.equal(typeof selectedPin,'function');
  f.onPublication(next=>{assert.equal(next,f.owners.terminalView());assert.deepEqual(total(),held);assert.equal(f.client.documentsMetadata,documentOwner);assert.equal(f.client.selectedDocumentPin,selectedPin);const unpin=control.pin();unpin();throw failure;});
  assert.throws(()=>f.client.dispose(),error=>error===failure);await f.client.recoveryDrain;assert.equal(f.view,prior);assert.deepEqual(total(),held);assert.equal(f.client.documentsMetadata,documentOwner);assert.equal(f.client.selectedDocumentMetadata,documentOwner);assert.equal(f.client.selectedDocumentPin,selectedPin);assert.equal(f.owners.ownership.currentRoots,2);
  const unpin=f.owners.renderModel(review.value).pin();unpin();const unpinControl=control.pin();unpinControl();
  f.onPublication(undefined);f.client.dispose();await f.client.recoveryDrain;assert.equal(f.view,f.owners.terminalView());assert.equal(f.client.documentsMetadata,undefined);assert.equal(f.client.selectedDocumentPin,undefined);assert.throws(()=>documents.pin(),/RELEASED/);assert.throws(()=>control.pin(),/RELEASED|UNOWNED/);assert.throws(()=>f.owners.renderModel(review.value),/UNOWNED/);assert.deepEqual(total(),f.before);
 }finally{f.onPublication(undefined);await f.close();documents.release();review.release();}
});
test('actual client patch publishes owned metadata and rejects without mutating the prior view',()=>{
 const f=fixture(),client=Object.create(EditorClient.prototype);let view=value({review:null,download:null,document:null});client.viewModels=f.owners;client.state={value:{get:()=>view},set:next=>{view=next;}};try{client.patch({selected:['layer'],uiPending:['request']});const prior=view;assert.equal(client.renderViewMetadata(view).value.selected,view.selected);assert.throws(()=>client.patch({selected:['invalid/id']}),/METADATA_ID/);assert.equal(view,prior);}finally{f.close();}
});
test('queued preferences own an immutable patch until actual dispatch settles',async()=>{
 const before=total(),client=Object.create(EditorClient.prototype),queue=deferred(),dispatch=deferred(),checkpoint={uiSeq:'1',preferences:{documentId:null,selectedLayerIds:[]}},selection=['one'];let sent;
 const owner={checkpoint,ownedDispatch:async request=>{sent=request;await dispatch.promise;return {value:{status:'accepted',uiSeq:'2'},release(){}};}};
 client.draftOwner=owner;client.uiTail=queue.promise;client.pinUI=()=>()=>{};client.state={value:{get:()=>({save:null})}};Object.defineProperty(client,'ui',{get:()=>checkpoint,set:next=>{Object.assign(checkpoint,next);}});Object.defineProperty(client,'sessionId',{value:'session'});
 const work=client.preferences({selectedLayerIds:selection});selection[0]='mutated';assert(total().cpu>before.cpu);queue.resolve();for(let i=0;i<8&&!sent;i++)await Promise.resolve();assert.deepEqual(sent.body.preferences.selectedLayerIds,['one']);assert(total().cpu>before.cpu);dispatch.resolve();await work;assert.deepEqual(total(),before);
});
test('same client disposal and remount require fresh admission before the first render',async()=>{
 const before=total(),client=Object.create(EditorClient.prototype),owners=new ViewModelOwners(),render=new RenderModelOwners();let view=value({review:null,download:null,document:null,documents:[]}),pressure;
 Object.assign(client,{viewModels:owners,state:{value:{get:()=>view},set:next=>{view=next;}},lifecycle:0,pendingRead:0,recoveryDrain:Promise.resolve(),retiredDraftOwners:new Set(),draftOwnerDrains:new Map(),viewReads:{release:async()=>{}},controlReads:{release:async()=>{}},session:{}});
 try{
  client.mountViewMetadata();render.begin([client.renderViewMetadata(view)]);render.commit();const old=client.renderViewMetadata(view);render.clear();client.dispose();await client.recoveryDrain;assert.deepEqual(total(),before);assert.throws(()=>old.pin(),/RELEASED|UNOWNED/);
  const disposed=view,s=allocationLedger.snapshot();pressure=allocationLedger.reserve({owner:'metadata-test-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-(s.cpuBytes-s.text.ownedReservationBytes)});assert.throws(()=>client.mountViewMetadata(),/ALLOCATION_BUDGET/);assert.equal(view,disposed);assert.throws(()=>client.renderViewMetadata(view),/UNOWNED/);pressure.release();pressure=undefined;
  client.mountViewMetadata();assert.notEqual(view,disposed);render.begin([client.renderViewMetadata(view)]);render.commit();assert.equal(owners.ownership.currentRoots,1);render.clear();client.dispose();await client.recoveryDrain;assert.deepEqual(total(),before);
 }finally{pressure?.release();render.clear();owners.releaseControlView();}
});

const shellSource=(await transformWithOxc(await readFile(root+'/src/ui/shell.ts','utf8'),'shell.ts')).code;
const shellClass=shellSource.slice(shellSource.indexOf('class EditorShell'),shellSource.lastIndexOf('scope.register('));
const shellModule=await import(data(`export const calls=[],nothing=Symbol('nothing'),entered=Error('entered Lit connection');let refusal,shellAttached=false;const editor={mountViewMetadata(){calls.push('admit');if(refusal)throw refusal;}};export function refuse(value){refusal=value;}class LitElement{connectedCallback(){calls.push('Lit');throw entered;}};${shellClass};export {EditorShell};`));
test('disconnected queued shell updates cannot read or render disposed control metadata',()=>{
 const shell=Object.create(shellModule.EditorShell.prototype);Object.defineProperty(shell,'isConnected',{value:false});Object.defineProperty(shell,'read',{get(){assert.fail('disconnected view snapshot must not be consumed');}});shell.renderModelOwners={commit(){assert.fail('disconnected update must not commit old owners');}};assert.equal(shell.render(),shellModule.nothing);assert.equal(shell.updated(),undefined);
});
test('actual shell reconnect admits before Lit and refusal cannot publish an unowned render',()=>{
 const shell=Object.create(shellModule.EditorShell.prototype),error=Error('admission refused');shellModule.calls.length=0;shellModule.refuse(error);assert.throws(()=>shell.connectedCallback(),value=>value===error);assert.deepEqual(shellModule.calls,['admit']);shellModule.calls.length=0;shellModule.refuse(undefined);assert.throws(()=>shell.connectedCallback(),value=>value===shellModule.entered);assert.deepEqual(shellModule.calls,['admit','Lit']);
});

import {stagedModuleURL} from '../adapter-upload-module.mjs';
import {adapterUploadURL} from '../owned-preview-module.mjs';
import {ownFixtureCommands} from '../owned-command-fixture.mjs';
import {modelMemoryURL} from '../ui-model-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {allocationsURL,readOwnedJSON,uiModule,uiModelOwnerURL} from '../ui-model-module.mjs';
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL),{UIModelOwner}=await import(uiModelOwnerURL);
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}');
const controls=await uiModule('src/ui/adapters.ts'),profile=await uiModule('src/adapters/profile.ts');
const {AdapterLibraryEditing}=await import(await stagedModuleURL('src/ui/adapter-library.ts',{'../observability/adapter-upload.js':adapterUploadURL,'lit':lit,'./adapters.js':controls,'./model-owner.js':uiModelOwnerURL,'../observability/model-memory.js':modelMemoryURL,'../adapters/profile.js':profile}));
const {DocumentDeletion}=await import(await uiModule('src/ui/deletion.ts',{'lit':lit,'./adapters.js':controls,'./model-owner.js':uiModelOwnerURL,'../observability/model-memory.js':modelMemoryURL}));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const hash='sha256:'+'1'.repeat(64);
const entry=(id='version')=>({versionId:id,adapterId:'adapter',version:'1',name:'Retained entry',declaredFamily:'ideogram-v4',declaredFormat:'fal',qualification:'unverified',available:true,weights:{hash,byteLength:'2000000000',mediaType:'application/octet-stream'},config:null,profileId:null,runtimeVerified:false,locallyEligible:false,reason:'Fixture'});
const receipt=id=>({documentId:id,planId:'plan',accepted:true,status:'cleanup-pending',estimatedEligibleBytes:'1',retainedBytes:'0',actualFreedBytes:'0',pendingBytes:'1',generation:'1'});
const totals=()=>{const s=allocationLedger.snapshot();return {cpu:s.cpuBytes,handles:s.handles,records:s.activeRecords};};
const pressure=()=>allocationLedger.reserve({owner:'ui-model-test-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-allocationLedger.snapshot().cpuBytes});
function fixture(){
  let transport=async()=>json({protocolVersion:1,items:[entry()],nextAfter:'next'});const reads=[],commands=[];
  const host={updateComplete:Promise.resolve(true),requestUpdate(){this.updateComplete=Promise.resolve(true);},querySelector(){return {focus(){}};}};
  const editor={view:{document:{id:'document',revision:'1'},ready:true},sessionId:'session',session:{identity:()=> 'client'},draftOwner:{drafts:new Map()},
    async command(value){commands.push(value);return [];},async flushDrafts(){},
    ownedJSON(path,owner,init,owns,maxBytes,kind){reads.push(path);return readOwnedJSON((path,init)=>transport(path,init),path,{owner,init,owns,maxBytes,kind});}};
  ownFixtureCommands(editor);
  const library=new AdapterLibraryEditing(host,editor),deletion=new DocumentDeletion(host,editor);library.render([],()=>{});deletion.render();
  return {host,editor,library,deletion,reads,commands,transport:value=>{transport=value;},async close(){await Promise.all([library.dispose(),deletion.dispose()]);}};
}
function json(value){const bytes=new TextEncoder().encode(JSON.stringify(value));return new Response(bytes,{headers:{'Content-Type':'application/json','Content-Length':String(bytes.length)}});}
function action(flow){const current={...flow.capture(),token:1,deleting:null,deleted:null};flow.active=current;return current;}

test('adapter page admission refusal preserves the exact prior page and complete cursor history',async()=>{
  const before=totals(),f=fixture();let held;
  try{
    await f.library.models.run(()=>f.library.list(()=>true));await turn();const prior=f.library.items,cursors=f.library.pageCursors,retained=totals();
    held=pressure();await assert.rejects(f.library.models.run(()=>f.library.list(()=>true,'next')),/ALLOCATION_BUDGET/);
    assert.equal(f.library.items,prior);assert.equal(f.library.pageCursors,cursors);assert.equal(f.library.pageIndex,0);assert.equal(f.reads.length,1);
    held.release();held=undefined;assert.deepEqual(totals(),retained);
    f.transport(async()=>json({protocolVersion:1,items:[entry('second')],nextAfter:null}));await f.library.models.run(()=>f.library.list(()=>true,'next'));await turn();
    assert.equal(f.library.items[0].versionId,'second');assert.deepEqual(f.library.pageCursors,['','next']);
  }finally{held?.release();await f.close();}assert.deepEqual(totals(),before);
});

test('adapter navigation refuses its page-history bound without trimming older cursors and First resets it',async()=>{
  const before=totals(),f=fixture();
  try{
    await f.library.models.run(()=>f.library.list(()=>true));
    const history=Array.from({length:1024},(_,i)=>i?'cursor_'+i:'');f.library.models.replace('cursors',f.library.models.model(history,65536));f.library.pageCursors=history;f.library.pageIndex=1023;
    const prior=f.library.items,reads=f.reads.length;await assert.rejects(f.library.models.run(()=>f.library.list(()=>true,'next')),/page history is full/);
    assert.equal(f.library.pageCursors,history);assert.equal(f.library.items,prior);assert.equal(f.reads.length,reads);
    await f.library.models.run(()=>f.library.list(()=>true,'first'));assert.deepEqual(f.library.pageCursors,['']);assert.equal(f.library.pageIndex,0);
  }finally{await f.close();}assert.deepEqual(totals(),before);
});

test('refused form edits restore the public value and preserve exact draft and File identities',async()=>{
  const before=totals(),f=fixture();let held;
  try{
    const file=new File(['bytes'],'unchanged.safetensors'),files={weights:file,config:null,provenance:null};f.library.form({files,draft:{...f.library.draft,name:'Original exact name'}});await turn();
    const draft=f.library.draft,values=f.library.files;assert.throws(()=>f.library.changeDraft({provenanceText:'x'.repeat(40000)}),/UI_MODEL_LIMIT/);assert.equal(f.library.draft,draft);
    held=pressure();const control={isConnected:true,value:'Refused complete replacement'},event={currentTarget:control,composedPath:()=>[control],defaultPrevented:false};
    f.library.edit(event,f.library.capture(),()=>control.value,value=>f.library.changeDraft({name:value}),draft.name);await turn();
    assert.equal(control.value,draft.name);assert.equal(f.library.draft,draft);assert.equal(f.library.files,values);assert.equal(f.library.files.weights,file);
    held.release();held=undefined;f.library.changeDraft({name:'Smaller'});assert.equal(f.library.draft.name,'Smaller');assert.equal(f.library.files.weights,file);
  }finally{held?.release();await f.close();}assert.deepEqual(totals(),before);
});

test('deletion read admission refusal retains the previous plan while disabling obsolete confirmation',async()=>{
  const before=totals(),f=fixture();let held;
  const plan={id:'plan',documentId:'document',documentRevision:'1',rootGeneration:'root',planHash:hash,exclusiveBytes:'1',retainedBytes:'0',pendingBytes:'1',histories:1,checkpoints:0,drafts:0,jobs:0,unresolvedAttempts:[],retainedRoots:[],externalCopies:'not-erased',irreversible:true};
  try{
    f.transport(async()=>json({plan}));const c=action(f.deletion);await f.deletion.models.run(()=>f.deletion.preview(c));const prior=f.deletion.plan;assert.equal(f.deletion.planReady,true);
    held=pressure();await assert.rejects(f.deletion.models.run(()=>f.deletion.preview(c)),/ALLOCATION_BUDGET/);
    assert.equal(f.deletion.plan,prior);assert.equal(f.deletion.planReady,false);const count=f.commands.length;await f.deletion.confirm(prior,c);assert.equal(f.commands.length,count);
  }finally{held?.release();await f.close();}assert.deepEqual(totals(),before);
});

test('deletion disposal waits for actual response cancellation and cannot publish the old receipt page',async()=>{
  const before=totals(),f=fixture(),started=deferred(),cancelled=deferred(),gate=deferred();let signal,released=false;
  try{
    f.transport(async(_path,init)=>{signal=init.signal;return new Response(new ReadableStream({pull(){started.resolve();},cancel(){cancelled.resolve();return gate.promise;}}),{headers:{'Content-Length':'100'}});});
    const c=action(f.deletion),read=f.deletion.models.run(()=>f.deletion.list(c)),rejected=assert.rejects(read,{name:'AbortError'});await started.promise;
    const release=f.deletion.dispose().then(()=>{released=true;});await cancelled.promise;await turn();assert.equal(signal.aborted,true);assert.equal(released,false);assert.deepEqual(f.deletion.receipts,[]);
    gate.resolve();await Promise.all([release,rejected]);assert.equal(released,true);assert.deepEqual(f.deletion.receipts,[]);
  }finally{gate.resolve();await f.close();}assert.deepEqual(totals(),before);
});

test('release waits through the parsed-owner handoff until the full consuming action releases it',async()=>{
  const before=totals(),f=fixture(),reached=deferred(),gate=deferred(),owner=new UIModelOwner(f.host,f.editor,'ui-handoff-test');let released=false;
  try{
    f.transport(async()=>json({items:[receipt('retained')]}));
    const work=owner.run(async()=>{const model=await owner.read('/handoff',()=>true);try{reached.resolve();await gate.promise;assert.equal(model.value.items[0].documentId,'retained');}finally{model.release();}});
    await reached.promise;const release=owner.release().then(()=>{released=true;});await turn();assert.equal(released,false);assert(totals().cpu>before.cpu);
    gate.resolve();await Promise.all([work,release]);assert.deepEqual(totals(),before);
  }finally{gate.resolve();await owner.release();await f.close();}
});

test('deferred controls keep models pinned through veto settlement and release drains that settlement',async()=>{
  const before=totals(),f=fixture();let released=false;
  try{
    f.library.changeDraft({name:'Retained through the pending native proposal'});
    const control={isConnected:true},event={currentTarget:control,composedPath:()=>[control],defaultPrevented:false};
    f.library.action(event,f.library.capture(),()=>assert.fail('A canceled control must not execute'));event.defaultPrevented=true;
    const release=f.library.releaseDocument().then(()=>{released=true;});await Promise.resolve();assert.equal(released,false);
    await release;assert.equal(f.library.lifecycle.pending,0);
  }finally{await f.close();}assert.deepEqual(totals(),before);
});

test('a failed Lit retirement keeps its actual model admitted until a successful release retry',async()=>{
  const before=totals();let fail=true;
  const host={updateComplete:Promise.resolve(true),requestUpdate(){this.updateComplete=fail?Promise.reject(Error('commit failed')):Promise.resolve(true);}};
  const owner=new UIModelOwner(host,{},'ui-retirement-test');owner.replace('view',owner.model({text:'retained'}));
  await assert.rejects(owner.release(),/UI_MODEL_RELEASE_INCOMPLETE/);assert(totals().cpu>before.cpu);assert.equal(owner.lifecycle.cleanupFailures,1);
  fail=false;await owner.release();assert.deepEqual(totals(),before);
});

test('failed pin acquisition releases earlier pins and the operation reservation',async()=>{
  const before=totals(),f=fixture(),owner=new UIModelOwner(f.host,f.editor,'ui-pin-test');let unpinned=0;
  owner.replace('first',{value:null,release(){},pin(){return ()=>{unpinned++;};}});owner.replace('second',{value:null,release(){},pin(){throw Error('pin failed');}});
  assert.throws(()=>owner.run(()=>{}),/pin failed/);assert.equal(unpinned,1);assert.deepEqual(totals(),before);await owner.release();await f.close();assert.deepEqual(totals(),before);
});

test('UI model scopes enforce their slot limit and route prompt payloads through the shared prompt budget',async()=>{
  const before=totals(),promptBefore=allocationLedger.snapshot().promptBytes,f=fixture();
  for(const slots of [0,257,1.5])assert.throws(()=>new UIModelOwner(f.host,f.editor,'ui-slot-test','control',{slots}),/UI_MODEL_LIMITS/);
  const owner=new UIModelOwner(f.host,f.editor,'ui-prompt-test','prompt',{slots:1});let refused;
  try{
    owner.replace('first',owner.model({text:'abc'}));assert.equal(allocationLedger.snapshot().promptBytes-promptBefore,14);
    refused=owner.model({text:'second'});assert.throws(()=>owner.replace('second',refused),/UI_MODEL_SLOTS/);assert.equal(owner.lifecycle.models,1);
    refused.release();refused=undefined;assert.equal(allocationLedger.snapshot().promptBytes-promptBefore,14);
  }finally{refused?.release();await owner.release();await f.close();}assert.deepEqual(totals(),before);
});

test('a pending GET retains an admitted path and refuses excessive paths before starting transport',async()=>{
  const before=totals(),f=fixture(),started=deferred(),gate=deferred(),owner=new UIModelOwner(f.host,f.editor,'ui-path-test'),path='/metadata?after=retained_cursor';
  try{
    assert.throws(()=>owner.read('/'+ 'x'.repeat(16384),()=>true),/UI_MODEL_PATH_LIMIT/);assert.equal(f.reads.length,0);
    f.transport(async()=>{started.resolve();await gate.promise;return json({value:'complete'});});
    const read=owner.run(async()=>{const model=await owner.read(path,()=>true);try{assert.equal(model.value.value,'complete');}finally{model.release();}});
    await started.promise;assert.equal(totals().cpu-before.cpu,path.length*2);gate.resolve();await read;
  }finally{gate.resolve();await owner.release();await f.close();}assert.deepEqual(totals(),before);
});

test('adapter staging transfers the actual command owner with its Asset subtree and releases staging metadata',async()=>{const before=totals(),f=fixture(),{cloneOwnedModel}=await import(modelMemoryURL);let result;try{const asset={id:'asset',version:'1'},events=cloneOwnedModel('adapter-test-events',[{type:'AssetRegistered',payload:{asset}}]),staged=cloneOwnedModel('adapter-test-stage',{protocolVersion:1,stagingId:'stage',purpose:'adapter',expectedBytes:'1',sha256:hash,mediaType:'application/octet-stream'});let eventReleased=false,stageReleased=false;f.editor.ownedUpload=async()=>({value:staged.value,pin:()=>staged.pin(),release(){stageReleased=true;staged.release();}});f.editor.ownedCommand=async()=>({value:events.value,pin:()=>events.pin(),release(){eventReleased=true;events.release();}});result=await f.library.models.run(()=>f.library.stage(new File(['x'],'weights.safetensors'),'adapter',()=>true));assert(result);assert.equal(result.value,events.value[0].payload.asset);assert.equal(stageReleased,true);assert.equal(eventReleased,false);const pin=result.pin();result.release();assert.equal(eventReleased,true);assert(totals().cpu>before.cpu);pin();result=null;}finally{result?.release();await f.close();}assert.deepEqual(totals(),before);});

test('document deletion keeps command acknowledgement owned through the dependent receipt read',async()=>{const before=totals(),f=fixture(),{cloneOwnedModel}=await import(modelMemoryURL),waiting=deferred(),receiptRead=deferred();try{const value=receipt('document'),events=cloneOwnedModel('deletion-test-events',[{type:'DocumentDeleted',payload:{id:'document'}}]);let released=false,first=true;f.editor.ownedCommand=async()=>({value:events.value,pin:()=>events.pin(),release(){released=true;events.release();}});f.transport(async()=>{if(first){first=false;receiptRead.resolve();return waiting.promise;}return json({receipt:value,jobs:[],next:null});});const plan={id:'plan',documentId:'document',documentRevision:'1',planHash:'hash',rootGeneration:'root'},c=action(f.deletion);f.deletion.plan=plan;f.deletion.planReady=true;const pending=f.deletion.models.run(()=>f.deletion.confirm(plan,c));await receiptRead.promise;assert.equal(released,false);waiting.resolve(json({receipt:value}));await pending;assert.equal(released,true);assert.equal(f.deletion.receipt.documentId,'document');}finally{waiting.resolve(json({receipt:receipt('document')}));await f.close();}assert.deepEqual(totals(),before);});

test('adapter document release aborts a native upload and waits for its owned response cleanup',async()=>{const before=totals(),f=fixture(),arrived=deferred(),{cloneOwnedModel}=await import(modelMemoryURL);let signal;try{f.editor.ownedUpload=(_file,_purpose,_media,_existing,_owns,external)=>{signal=external;return arrived.promise;};const current=f.library.capture(),work=f.library.models.run(()=>f.library.stage(new File(['x'],'weights.safetensors'),'adapter',()=>f.library.owns(current)));await turn();let done=false;const closing=f.library.releaseDocument().then(()=>{done=true;});assert.equal(signal.aborted,true);await turn();assert.equal(done,false);arrived.resolve(cloneOwnedModel('adapter-test-stage',{protocolVersion:1,stagingId:'stage',purpose:'adapter',expectedBytes:'1',sha256:hash,mediaType:'application/octet-stream'}));assert.equal(await work,null);await closing;assert.equal(done,true);assert.equal(f.library.uploadControllers.size,0);}finally{await f.close();}assert.deepEqual(totals(),before);});

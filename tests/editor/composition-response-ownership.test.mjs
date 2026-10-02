// Authored during the source freeze; no execution evidence is implied.
// Actual controller, model owners, Composition parser and central ledger. Only
// transport command outcomes, Lit rendering and unrelated native UI are scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc} from 'vite';
const roots=[process.env.RESPONSE_CALLER_STAGED_ROOT,process.env.OBSERVABILITY_STAGED_ROOT,process.env.COMPOSITION_STAGED_ROOT,'.'].filter(Boolean);
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function source(path){for(const root of roots)try{return await readFile(root+'/'+path,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}throw Error('Missing source '+path);}
async function module(path,imports={}){let code=(await transformWithOxc(await source(path),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const diagnosticURL=await module('src/observability/diagnostic-memory.ts');
const observationURL=await module('src/observability/composition-observations.ts',{'./diagnostic-memory.js':diagnosticURL});
const allocationURL=await module('src/observability/allocations.ts',{'./diagnostic-memory.js':diagnosticURL,'./composition-observations.js':observationURL});
const promptURL=await module('src/observability/prompt-memory.ts',{'./allocations.js':allocationURL});
const modelURL=await module('src/observability/model-memory.ts',{'./allocations.js':allocationURL,'./prompt-memory.js':promptURL});
const controlURL=await module('src/state/control-memory.ts',{'../observability/allocations.js':allocationURL});
const draftURL=await module('src/state/draft-values.ts',{'../observability/allocations.js':allocationURL,'../observability/prompt-memory.js':promptURL,'../observability/model-memory.js':modelURL,'./control-memory.js':controlURL});
const {DraftRegistrations}=await import(draftURL);
const lifetimeURL=await module('src/ui/composition-lifetime.ts'),{CompositionLifetime}=await import(lifetimeURL);
const coreURL=await module('src/composition/core.ts');
const compositionViewURL=await module('src/composition/view.ts');
const memoryURL=await module('src/composition/memory.ts',{'../observability/allocations.js':allocationURL,'../observability/prompt-memory.js':promptURL,'../observability/composition-observations.js':observationURL,'./view.js':compositionViewURL,'./core.js':coreURL});
const jsonURL=await module('src/protocol/json.ts'),adapterURL=await module('src/ui/adapters.ts');
const rasterURL=await module('src/raster/core.ts'),mappingURL=await module('src/raster/mapping.ts',{'./core.js':rasterURL}),shaURL=await module('src/protocol/sha256.ts');
const requestPlanURL=await module('src/request/raster-plan.ts',{'../raster/core.js':rasterURL,'../protocol/json.js':jsonURL});
// The real labels/operation guard come from request/core. Unrelated wire
// validators are forbidden stand-ins; this fixture exercises no request parsing.
const validationURL=data('const unused=()=>{throw Error("Unexpected wire validation")};export {unused as blob,unused as keys,unused as id,unused as seq,unused as requireValue};');
const requestURL=await module('src/request/core.ts',{'./raster-plan.js':requestPlanURL,'../protocol/json.js':jsonURL,'../protocol/sha256.js':shaURL,'../protocol/validate.js':validationURL,'../raster/mapping.js':mappingURL,'../protocol/adapters.js':pathToFileURL(resolve('dist/local/src/protocol/adapters.js')).href});
const controllerURL=await module('src/ui/composition.ts',{
 'lit':data('export const nothing=null,noChange=Symbol.for("fixture.noChange");export const html=(strings,...values)=>({strings,values});'),
 '@en-reve/elements/color-picker.js':data('export const parseColor=()=>{throw Error("unused color")},exportSRGB=parseColor;'),
 '../state/destination.js':data('export const chooseDestination=()=>{throw Error("unused destination")},writeDestination=chooseDestination;'),
 '../observability/browser.js':data('export const browserPhases={recorder:{start(){return {end(){}};}}};'),
 '../observability/composition-observations.js':observationURL,'./adapters.js':adapterURL,'./composition-lifetime.js':lifetimeURL,'../protocol/json.js':jsonURL,
 '../request/core.js':requestURL,'../composition/core.js':coreURL,'../composition/memory.js':memoryURL,'../observability/prompt-memory.js':promptURL,
});
const {CompositionEditing}=await import(controllerURL),{emptyComposition}=await import(coreURL),{compositionPayloadBytes,compositionAllowance,cloneCompositionValue}=await import(memoryURL),{cloneOwnedModel}=await import(modelURL),{allocationLedger,ALLOCATION_LIMITS}=await import(allocationURL);
const baseline=allocationLedger.snapshot();
const totals=()=>{const s=allocationLedger.snapshot();return {cpu:s.cpuBytes-baseline.cpuBytes,prompt:s.promptBytes-baseline.promptBytes,handles:s.handles-baseline.handles,records:s.activeRecords-baseline.activeRecords};};
const zero={cpu:0,prompt:0,handles:0,records:0};
const fixtures=new Set(),gates=new Set(),helperFixtures=new Set(),helperActions=new Set();
const deferred=()=>{let yes,no;const promise=new Promise((a,b)=>{yes=a;no=b;}),gate={promise,resolve(value){gates.delete(gate);yes(value);},reject(error){gates.delete(gate);no(error);}};gates.add(gate);return gate;};
const boundary=(action,entered)=>Promise.race([entered.promise,action.then(()=>{throw Error('Action ended before the expected consumer boundary');})]);
const flush=async()=>{for(let i=0;i<32;i++)await Promise.resolve();};
function fixture(t){
 const registrations=new DraftRegistrations();
 const document={id:'document',revision:'1',width:360,height:200},value=emptyComposition(360,200,'composition');value.scene='A retained scene';
 const stages=[],commands=[],events=[],reads=[],checkpoints=[];let controller,stageHook=()=>{},command=async()=>[],stageNumber=0,checkpoint;
 const jsonResponse=value=>{const text=JSON.stringify(value);return new Response(text,{headers:{'content-length':String(Buffer.byteLength(text))}});};
 let read=async()=>jsonResponse({composition:value,layers:[],bindings:{},revision:document.revision});
 const editor={sessionId:'session',draftOwner:{drafts:new Map(),refuseChange:(id,doc)=>registrations.refuse(id,doc)},registerDraft:(id,doc)=>registrations.register(id,doc),view:{ready:true,document},ui:{drafts:[]},
  session:{identity:()=> 'client',async transport(path){reads.push(path);return read(path);}},
  pinUI(){if(!checkpoint)return ()=>{};const row=checkpoint,release=row.owned.pin();row.pins++;let live=true;return ()=>{if(live){live=false;row.pins--;release();}};},
  changeDraft(id){const previous=this.draftOwner.drafts.get(id),generation=String(Number(previous?.generation??0)+1);this.draftOwner.drafts.set(id,{generation,savedGeneration:generation});registrations.delete(id);},async flushDrafts(){},
  async command(){throw Error('RAW_COMMAND_RESPONSE_FORBIDDEN');},async stageTextBlob(){throw Error('RAW_STAGE_RESPONSE_FORBIDDEN');},
  async ownedStageTextBlob(blob,mediaType,purpose,owns){assert.equal(purpose,'text');assert.equal(owns(),true);const owned=cloneOwnedModel('composition-stage-response',{hash:'sha256:'+String(++stageNumber).repeat(64),byteLength:String(blob.size),mediaType}),row={value:owned.value,active:true,mediaType};stages.push(row);stageHook(row);return {value:owned.value,pin:()=>owned.pin(),release(){if(!row.active)return;row.active=false;owned.release();/* Runner poisons released transport graph to expose a borrowed draft alias. */row.value.hash='released-stage';}};},
  async withCommandEvents(body,consume,owner){commands.push({body,owner});const retained=cloneOwnedModel('composition-command-response',await command(body)),row={value:retained.value,active:true};events.push(row);try{return await consume(retained.value);}finally{row.active=false;retained.release();}},
 };
 const host={requestUpdate(){},updateComplete:Promise.resolve(),querySelector(){return null;}};
 controller=new CompositionEditing(host,editor,()=>{},()=>{},async()=>{},()=>{});
 const fixture={controller,editor,host,registrations,stages,commands,events,reads,checkpoints,jsonResponse,setRead(value){read=value;},setUI(value){const next=value?{owned:cloneOwnedModel('composition-ui-checkpoint',value),pins:0,active:true}:undefined;const old=checkpoint;checkpoint=next;editor.ui=next?.owned.value;if(next)checkpoints.push(next);if(old){old.active=false;old.owned.release();}},async close(){host.updateComplete=Promise.resolve();try{await controller.dispose();}finally{this.setUI(null);registrations.dispose();assert.equal(registrations.inspect().editableBorrowers,0,'Controller failed to drain draft registrations');await registrations.drain();}},setCommand(value){command=value;},setStageHook(value){stageHook=value;},async initial(){await controller.sync();controller.touch();}};fixtures.add(fixture);return fixture;
}
test.afterEach(async()=>{for(const gate of [...gates])gate.resolve();for(const release of [...helperActions])release();const outcomes=await Promise.allSettled([...fixtures,...helperFixtures].map(f=>f.close()));fixtures.clear();helperFixtures.clear();for(const outcome of outcomes)assert.equal(outcome.status,'fulfilled',outcome.reason?.stack);assert.deepEqual(totals(),zero);});

test('Composition commit retains its staged reference until the command consumer settles',async t=>{
 const f=fixture(t),entered=deferred(),gate=deferred();await f.initial();
 f.setCommand(async body=>{assert.equal(f.stages[0].active,true);assert.equal(body.composition.value,f.stages[0].value);entered.resolve();await gate.promise;assert.equal(f.stages[0].active,true);return [{type:'CompositionVersionCommitted',payload:{}}];});
 const committing=f.controller.commit();try{await boundary(committing,entered);assert.equal(f.stages[0].active,true);assert.ok(totals().cpu>0);
 gate.resolve();await committing;assert.equal(f.stages[0].active,false);assert.equal(f.events[0].active,false);assert.equal(f.controller.dirty,false);}finally{gate.resolve();await committing.catch(()=>{});}
});

// The controller and all ownership/command response consumers are real. Only
// the accepted transport result and host render completion are scripted.
test('held Composition commit retires later rendered generations and publishes exact accepted state',async t=>{
 const f=fixture(t),entered=deferred(),gate=deferred();await f.initial();
 f.controller.add('obj');f.controller.c.elements[0].bounds={mode:'literal',value:{rect:[0,0,10,10],transform:[1,0,0,1,0,0]}};
 f.controller.request();f.controller.inspector();f.controller.dialog();await flush();
 const draft=f.controller.c,draftId=f.controller.draftId,initialRender=f.controller.payloads.get('render-request');
 assert(initialRender);assert(f.controller.payloads.has('render-box-projection'));
 f.setCommand(async()=>{entered.resolve();await gate.promise;
  f.editor.view.document={...f.editor.view.document,revision:'2'};
  f.setRead(async()=>f.jsonResponse({composition:draft,layers:[],bindings:{},revision:'2'}));
  await f.controller.sync();
  assert.equal(f.controller.c,draft,'Accepted refresh preserves the pending editable draft');
  assert.equal(f.controller.committing,true);
  return [{type:'CompositionVersionCommitted',payload:{}}];
 });
 const committing=f.controller.commit();
 try{await boundary(committing,entered);
  for(let i=0;i<128;i++){
   f.controller.request();f.controller.inspector();f.controller.dialog();await flush();
   assert.equal(f.controller.lifecycle.retiredOwners,0,'Each scripted host commit retires old root references');
   assert.ok(f.controller.lifecycle.owners<24,'A held action must not accumulate unrelated completed render generations');
   assert.equal(f.controller.committing,true);assert.equal(f.stages[0].active,true);
  }
  const releaseInitial=initialRender.pin();releaseInitial();
  gate.resolve();await committing;await flush();
  assert.equal(f.commands.length,1);assert.equal(f.commands[0].body.type,'CommitCompositionVersion');
  assert.equal(f.controller.message,'Composition applied and saved locally.');
  assert.deepEqual(f.controller.base,{id:'document',revision:'2',width:360,height:200});
  assert.equal(f.controller.c,draft);assert.deepEqual(f.controller.accepted,draft);assert.notEqual(f.controller.accepted,draft);
  assert.notEqual(f.controller.draftId,draftId);assert.equal(f.controller.dirty,false);assert.equal(f.controller.committing,false);
  assert.equal(f.controller.lifecycle.pendingOperations,0);assert.equal(f.controller.lifecycle.pendingPins,0);assert.equal(f.controller.lifecycle.retiredOwners,0);
  assert.equal(f.stages[0].active,false);assert.equal(f.events[0].active,false);
  assert.throws(()=>initialRender.pin(),/COMPOSITION_OWNER_RELEASED/);
  await f.close();fixtures.delete(f);assert.deepEqual(totals(),zero);
 }finally{gate.resolve();await committing.catch(()=>{});}
});

test('Composition command failure releases the staged root and retains the dirty draft',async t=>{
 const f=fixture(t),failure=Error('command failed');await f.initial();const draft=f.controller.c;
 f.setCommand(async()=>{assert.equal(f.stages[0].active,true);throw failure;});
 await assert.rejects(f.controller.commit(),error=>error===failure);assert.equal(f.stages[0].active,false);assert.equal(f.controller.c,draft);assert.equal(f.controller.dirty,true);assert.equal(f.controller.committing,false);
});

test('closing Composition during commit keeps response ownership until the accepted command drains',async t=>{
 const f=fixture(t),entered=deferred(),gate=deferred();await f.initial();f.setCommand(async()=>{entered.resolve();return gate.promise;});
 const committing=f.controller.commit();let closing;try{await boundary(committing,entered);let closed=false;closing=f.controller.releaseDocument().then(()=>{closed=true;});await flush();assert.equal(closed,false);assert.equal(f.stages[0].active,true);
 gate.resolve([{type:'CompositionVersionCommitted',payload:{}}]);await committing;await closing;assert.equal(f.controller.c,null);assert.equal(f.stages[0].active,false);assert.equal(f.events[0].active,false);assert.deepEqual(totals(),zero);}finally{gate.resolve([]);await committing.catch(()=>{});await closing;}
});

test('retained raw Composition source is independently admitted before its stage owner ends',async t=>{
 const f=fixture(t);await f.initial();await f.controller.retain(new Blob(['{}']));
 assert.equal(f.stages[0].active,false);assert.equal(f.stages[0].value.hash,'released-stage');
 assert.equal(f.controller.c.raw[0].hash,'sha256:'+'1'.repeat(64));assert.notEqual(f.controller.c.raw[0],f.stages[0].value);assert.equal(f.controller.sourceRaw,f.controller.c.raw[0]);
});

test('approved Composition retains an independent prompt reference after both staged responses end',async t=>{
 const f=fixture(t);await f.initial();f.controller.preview();await f.controller.approve();
 assert.deepEqual(f.stages.map(row=>row.mediaType),['text/plain','application/json']);assert(f.stages.every(row=>!row.active));
 assert.equal(f.controller.c.review.prompt.hash,'sha256:'+'1'.repeat(64));assert.notEqual(f.controller.c.review.prompt,f.stages[0].value);assert.equal(f.commands[0].body.type,'ApprovePromptProjection');
});

test('Composition approval drains its saved draft before staging the exact reviewed prompt',async t=>{
 const f=fixture(t),entered=deferred(),gate=deferred();await f.initial();f.controller.preview();const exact=f.controller.exact,draft=f.controller.c;let flushes=0;const stagedText=[],stage=f.editor.ownedStageTextBlob;
 f.editor.flushDrafts=async()=>{if(++flushes===1){entered.resolve();await gate.promise;}};
 f.editor.ownedStageTextBlob=async(...args)=>{stagedText.push(await args[0].text());return stage(...args);};
 const approving=f.controller.approve();try{await boundary(approving,entered);assert.equal(f.stages.length,0);assert.equal(f.commands.length,0);assert.equal(draft.review,null);
  gate.resolve();await approving;assert.equal(stagedText[0],exact);assert.deepEqual(f.stages.map(row=>row.mediaType),['text/plain','application/json']);assert.equal(f.commands.length,1);assert.equal(f.commands[0].body.type,'ApprovePromptProjection');assert.equal(f.controller.c.review.prompt.hash,'sha256:'+'1'.repeat(64));assert(f.stages.every(row=>!row.active));assert.equal(f.controller.lifecycle.pendingOperations,0);
 }finally{gate.resolve();await approving.catch(()=>{});}
});

for(const change of ['generation','owner','owner-unsaved','session','connection','identity','document','revision','document-epoch'])test('Composition approval refuses '+change+' changes while its draft flush is held',async t=>{
 const f=fixture(t),entered=deferred(),gate=deferred();await f.initial();f.controller.preview();const draft=f.controller.c,id=draft.id;let flushes=0;
 f.editor.flushDrafts=async()=>{flushes++;entered.resolve();await gate.promise;};
 const approving=f.controller.approve();try{await boundary(approving,entered);assert.equal(f.stages.length,0);assert.equal(f.commands.length,0);
  if(change==='generation')f.controller.touch();else if(change==='owner')f.editor.draftOwner={...f.editor.draftOwner,drafts:new Map()};else if(change==='owner-unsaved')f.editor.draftOwner={...f.editor.draftOwner,drafts:new Map([[f.controller.draftId,{generation:'2',savedGeneration:'1'}]])};else if(change==='session')f.editor.sessionId='replacement-session';else if(change==='connection')f.editor.session={...f.editor.session};else if(change==='identity')f.editor.session.identity=()=> 'replacement-client';else if(change==='document')f.editor.view.document={...f.editor.view.document,id:'replacement-document'};else if(change==='revision')f.editor.view.document={...f.editor.view.document,revision:'2'};else f.editor.documentEpoch=1;
  gate.resolve();await assert.rejects(approving,/Projection changed while saving/);assert.equal(flushes,1,'Stale approval cannot flush a replacement owner');assert.equal(f.stages.length,0);assert.equal(f.commands.length,0);assert.equal(draft.review,null);if(change!=='generation')assert.equal(draft.id,id);assert.equal(f.controller.lifecycle.pendingOperations,0);
 }finally{gate.resolve();await approving.catch(()=>{});}
});

test('Composition approval preserves a draft-flush failure without staging a prompt',async t=>{
 const f=fixture(t),failure=Error('draft persistence failed');await f.initial();f.controller.preview();const draft=f.controller.c;
 f.editor.flushDrafts=async()=>{throw failure;};await assert.rejects(f.controller.approve(),error=>error===failure);assert.equal(f.stages.length,0);assert.equal(f.commands.length,0);assert.equal(draft.review,null);assert.equal(f.controller.lifecycle.pendingOperations,0);
});

test('Composition approval releases a staged prompt when its owner changes before preparation settles',async t=>{
 const f=fixture(t);await f.initial();f.controller.preview();const draft=f.controller.c;f.setStageHook(()=>{f.editor.draftOwner={...f.editor.draftOwner,drafts:new Map(f.editor.draftOwner.drafts)};});
 await assert.rejects(f.controller.approve(),/Projection changed during preparation/);assert.equal(f.stages.length,1);assert.equal(f.stages[0].active,false);assert.equal(f.commands.length,0);assert.equal(draft.review,null);
});

test('prompt-reference admission refusal ends its response without mutating the Composition review',async t=>{
 const f=fixture(t);await f.initial();f.controller.preview();const draft=f.controller.c,id=draft.id;let pressure;
 f.setStageHook(()=>{pressure=allocationLedger.reserve({owner:'composition-response-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes});});
 try{await assert.rejects(f.controller.approve(),/PROMPT_MEMORY_BUDGET/);assert.equal(f.stages[0].active,false);assert.equal(f.controller.c,draft);assert.equal(draft.id,id);assert.equal(draft.review,null);assert.equal(f.commands.length,0);}finally{pressure?.release();}
});

test('Composition base owns only four scalars without visiting document image or layer graphs',async t=>{
 const f=fixture(t);let reads=0;
 for(const key of ['image','orderedLayerIds'])Object.defineProperty(f.editor.view.document,key,{get(){reads++;throw Error('Full document graph was visited');}});
 await f.initial();assert.equal(reads,0);assert.deepEqual(f.controller.base,{id:'document',revision:'1',width:360,height:200});assert(f.controller.payloads.has('base'));
 const before=allocationLedger.snapshot().promptBytes,copy=f.controller.captureBase();
 try{assert.equal(allocationLedger.snapshot().promptBytes-before,compositionPayloadBytes(copy.value));assert.notEqual(copy.value,f.controller.base);assert.equal(reads,0);}finally{copy.owner.release();}
});

test('pending current review reads a retained scalar snapshot rather than a mutable client document',async t=>{
 const f=fixture(t),gate=deferred(),entered=deferred();await f.initial();const original=f.editor.view.document;
 f.setRead(async()=>{entered.resolve();return gate.promise;});const current=f.controller.current();
 try{await boundary(current,entered);original.width=999;original.height=888;
  gate.resolve(f.jsonResponse({composition:null,layers:[],bindings:{},revision:'1'}));await current;
  assert.deepEqual(f.controller.base,{id:'document',revision:'1',width:360,height:200});assert.equal(f.controller.c.frame.documentWidth,360);assert.equal(f.controller.c.frame.documentHeight,200);
 }finally{gate.resolve(f.jsonResponse({composition:null,layers:[],bindings:{},revision:'1'}));await current.catch(()=>{});}
});

test('base snapshot refusal happens before transport and preserves accepted controller state',async t=>{
 const f=fixture(t);await f.initial();const base=f.controller.base,draft=f.controller.c,reads=f.reads.length;
 const pressure=allocationLedger.reserve({owner:'composition-base-full',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes});
 try{await assert.rejects(f.controller.current(),/PROMPT_MEMORY_BUDGET/);assert.equal(f.reads.length,reads);assert.equal(f.controller.base,base);assert.equal(f.controller.c,draft);}finally{pressure.release();}
});

test('successor base admission failure leaves the old view draft and identity together',async t=>{
 const f=fixture(t);await f.initial();const previous={base:f.controller.base,draft:f.controller.c,accepted:f.controller.accepted,layers:f.controller.layers,key:f.controller.key};
 const value=emptyComposition(360,200,'successor');value.scene='Successor scene';f.editor.view.document={id:'successor-document',revision:'1',width:360,height:200};f.setRead(async()=>f.jsonResponse({composition:value,layers:[],bindings:{},revision:'1'}));
 const barrier=deferred();f.controller.settlements.add(barrier.promise);const syncing=f.controller.sync();void syncing.catch(()=>{});let pressure;
 try{await flush();assert.equal(f.reads.length,2);const draftBytes=compositionPayloadBytes({composition:value,bindings:{},numbers:{},rawText:'',color:f.controller.color,selected:''})+4096;
  pressure=allocationLedger.reserve({owner:'composition-base-successor-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes-draftBytes});
  f.controller.settlements.delete(barrier.promise);barrier.resolve();await assert.rejects(syncing,/PROMPT_MEMORY_BUDGET/);
  assert.equal(f.controller.base,previous.base);assert.equal(f.controller.c,previous.draft);assert.equal(f.controller.accepted,previous.accepted);assert.equal(f.controller.layers,previous.layers);assert.equal(f.controller.key,previous.key);
 }finally{pressure?.release();f.controller.settlements.delete(barrier.promise);barrier.resolve();await syncing.catch(()=>{});}
});

test('document close drains a pending current snapshot before refunding its final pin',async t=>{
 const f=fixture(t),gate=deferred(),entered=deferred();await f.initial();f.setRead(async()=>{entered.resolve();return gate.promise;});const current=f.controller.current();let closing;
 try{await boundary(current,entered);let closed=false;closing=f.controller.releaseDocument().then(()=>{closed=true;});await flush();assert.equal(closed,false);assert.equal(f.controller.base,null);assert.ok(totals().prompt>0);
  gate.resolve(f.jsonResponse({composition:null,layers:[],bindings:{},revision:'1'}));await current;await closing;assert.equal(f.controller.base,null);assert.equal(f.controller.c,null);assert.deepEqual(totals(),zero);
 }finally{gate.resolve(f.jsonResponse({composition:null,layers:[],bindings:{},revision:'1'}));await current.catch(()=>{});await closing;}
});

function restoringFixture(t){
 const f=fixture(t),gate=deferred(),entered=deferred(),saved=emptyComposition(360,200,'restored');saved.scene='Saved checkpoint scene';
 f.setUI({drafts:[{id:'saved-draft',kind:'composition',documentId:'document',status:'saved-unapplied',generation:'7',expectedDocumentRevision:'1'}]});
 f.setRead(async path=>{if(path.startsWith('/api/v1/ui/')){entered.resolve();return gate.promise;}return f.jsonResponse({composition:null,layers:[],bindings:{},revision:'1'});});
 return {...f,gate,entered,response:()=>f.jsonResponse({graph:{composition:saved},bindings:{}})};
}

test('saved checkpoint selection stays pinned across restore after the client publishes another checkpoint',async t=>{
 const f=restoringFixture(t),syncing=f.controller.sync();
 try{await boundary(syncing,f.entered);const previous=f.checkpoints[0];assert.equal(previous.pins,1);f.setUI({drafts:[]});assert.equal(previous.active,false);assert.equal(previous.pins,1);
  f.gate.resolve(f.response());await syncing;assert.equal(previous.pins,0);assert.equal(f.controller.c.scene,'Saved checkpoint scene');assert.equal(f.controller.draftId,'saved-draft');assert.deepEqual(f.controller.base,{id:'document',revision:'1',width:360,height:200});
 }finally{f.gate.resolve(f.response());await syncing.catch(()=>{});}
});

test('closing a restore drains the selected checkpoint pin and rejects stale publication',async t=>{
 const f=restoringFixture(t),syncing=f.controller.sync();let closing;
 try{await boundary(syncing,f.entered);const previous=f.checkpoints[0];f.setUI(null);let closed=false;closing=f.controller.releaseDocument().then(()=>{closed=true;});await flush();assert.equal(closed,false);assert.equal(previous.pins,1);
  f.gate.resolve(f.response());await syncing;await closing;assert.equal(previous.pins,0);assert.equal(f.controller.c,null);assert.equal(f.controller.base,null);assert.deepEqual(totals(),zero);
 }finally{f.gate.resolve(f.response());await syncing.catch(()=>{});await closing;}
});

// Real fixed owner reservations and DraftRegistrations; only host completion is
// scripted. These cases exercise the lifetime helper used by the controller.
function lifetimeFixture(){
 const registrations=new DraftRegistrations();let render=async()=>{};
 const owner=new CompositionLifetime(bytes=>compositionAllowance('composition-lifetime-test-metadata',bytes),request=>render(request));
 const f={owner,registrations,setRender(next){render=next;},owned(id='draft',bytes=100,inheritActions=true){const release=registrations.register(id,'document'),payload=compositionAllowance('composition-lifetime-test-payload',bytes);try{return owner.own(payload,release,inheritActions);}catch(error){payload.release();release();throw error;}},action(){const done=owner.action();let live=true;const release=()=>{if(live){live=false;helperActions.delete(release);done();}};helperActions.add(release);return release;},async close(){await owner.close();registrations.dispose();await registrations.drain();}};helperFixtures.add(f);return f;
}

test('Composition lifetime keeps retired payload and registration until the actual render completes',async()=>{
 const f=lifetimeFixture(),gate=deferred();f.setRender(()=>gate.promise);const value=f.owned(),held=totals();value.release();await flush();
 assert.equal(f.owner.state.retired,1);assert.equal(f.registrations.inspect().editableBorrowers,1);assert.deepEqual(totals(),held);
 gate.resolve();await flush();assert.equal(f.owner.state.owners,0);assert.equal(f.registrations.inspect().editableBorrowers,0);
});

test('Composition action pins successors adopted after the action began through final settlement',async()=>{
 const f=lifetimeFixture(),release=f.action(),first=f.owned('first'),second=f.owned('second');first.release();second.release();await flush();
 assert.equal(f.owner.state.retired,0);assert.equal(f.owner.state.owners,2);assert.equal(f.registrations.inspect().editableBorrowers,2);
 release();release();assert.equal(f.owner.state.owners,0);assert.equal(f.registrations.inspect().editableBorrowers,0);
});

test('Composition action keeps its initial render snapshot without inheriting later settled render owners',async()=>{
 const f=lifetimeFixture(),initial=f.owned('initial-render',111,false),release=f.action(),held=totals();
 try{
  initial.release(false);await flush();
  assert.equal(f.owner.state.owners,1);assert.equal(f.owner.state.retired,0);assert.equal(f.owner.state.actions,1);
  assert.equal(f.registrations.inspect().editableBorrowers,1);assert.deepEqual(totals(),held);
  for(let i=0;i<192;i++){
   const next=f.owned('later-render',200+i,false);assert.equal(f.owner.state.owners,2);
   next.release(false);await flush();
   assert.equal(f.owner.state.owners,1,'settled render '+i+' was retained by an earlier action');
   assert.equal(f.owner.state.retired,0);assert.equal(f.registrations.inspect().editableBorrowers,1);assert.deepEqual(totals(),held);
  }
  const unpin=initial.pin();unpin();assert.deepEqual(totals(),held);
  release();release();assert.equal(f.owner.state.owners,0);assert.equal(f.registrations.inspect().editableBorrowers,0);
  assert.throws(()=>initial.pin(),/COMPOSITION_OWNER_RELEASED/);
 }finally{release();}
});

test('a later overlapping Composition action snapshots the current render even when earlier actions did not inherit it',async()=>{
 const f=lifetimeFixture(),first=f.action(),render=f.owned('current-render',222,false),second=f.action(),held=totals();
 try{
  render.release(false);await flush();
  assert.equal(f.owner.state.owners,1);assert.equal(f.owner.state.retired,0);assert.equal(f.owner.state.actions,2);assert.deepEqual(totals(),held);
  first();assert.equal(f.owner.state.actions,1);assert.equal(f.owner.state.owners,1);assert.deepEqual(totals(),held);
  const next=f.owned('newer-render',333,false);next.release(false);await flush();
  assert.equal(f.owner.state.owners,1);assert.equal(f.registrations.inspect().editableBorrowers,1);assert.deepEqual(totals(),held);
  second();assert.equal(f.owner.state.actions,0);assert.equal(f.owner.state.owners,0);assert.equal(f.registrations.inspect().editableBorrowers,0);
  assert.throws(()=>render.pin(),/COMPOSITION_OWNER_RELEASED/);
 }finally{first();second();}
});

test('future Composition domain owners still inherit every pending action by default and by explicit request',async()=>{
 const f=lifetimeFixture(),first=f.action(),second=f.action(),defaultDomain=f.owned('default-domain',321),explicitDomain=f.owned('explicit-domain',654,true),held=totals();
 try{
  defaultDomain.release();explicitDomain.release();await flush();
  assert.equal(f.owner.state.owners,2);assert.equal(f.owner.state.retired,0);assert.equal(f.owner.state.actions,2);
  assert.equal(f.registrations.inspect().editableBorrowers,2);assert.deepEqual(totals(),held);
  const render=f.owned('unrelated-render',777,false);render.release(false);await flush();
  assert.equal(f.owner.state.owners,2);assert.equal(f.registrations.inspect().editableBorrowers,2);assert.deepEqual(totals(),held);
  first();assert.equal(f.owner.state.actions,1);assert.equal(f.owner.state.owners,2);assert.deepEqual(totals(),held);
  second();assert.equal(f.owner.state.actions,0);assert.equal(f.owner.state.owners,0);assert.equal(f.registrations.inspect().editableBorrowers,0);
  assert.throws(()=>defaultDomain.pin(),/COMPOSITION_OWNER_RELEASED/);assert.throws(()=>explicitDomain.pin(),/COMPOSITION_OWNER_RELEASED/);
 }finally{first();second();}
});

test('future render exclusion never refunds a Composition payload before the blocked host commit confirms retirement',async()=>{
 const f=lifetimeFixture(),release=f.action(),gate=deferred();f.setRender(()=>gate.promise);
 const render=f.owned('blocked-render',444,false),held=totals();
 try{
  render.release(false);await flush();
  assert.equal(f.owner.state.owners,1);assert.equal(f.owner.state.retired,1);assert.equal(f.owner.state.actions,1);
  assert.equal(f.registrations.inspect().editableBorrowers,1);assert.deepEqual(totals(),held);
  release();assert.equal(f.owner.state.actions,0);assert.equal(f.owner.state.owners,1);assert.deepEqual(totals(),held);
  gate.resolve();await flush();
  assert.equal(f.owner.state.owners,0);assert.equal(f.owner.state.retired,0);assert.equal(f.registrations.inspect().editableBorrowers,0);
  assert.throws(()=>render.pin(),/COMPOSITION_OWNER_RELEASED/);await f.close();assert.deepEqual(totals(),zero);
 }finally{release();gate.resolve();}
});

test('a failed host retirement keeps an excluded Composition render owner until a confirmed close retry',async()=>{
 const f=lifetimeFixture(),release=f.action(),failure=Error('render-only host commit failed');f.setRender(async()=>{throw failure;});
 const render=f.owned('failed-render',555,false),held=totals();
 try{
  render.release(false);await flush();
  assert.equal(f.owner.state.renderFailed,true);assert.equal(f.owner.state.owners,1);assert.equal(f.owner.state.retired,1);
  assert.equal(f.registrations.inspect().editableBorrowers,1);assert.deepEqual(totals(),held);
  release();assert.equal(f.owner.state.actions,0);assert.deepEqual(totals(),held);
  await assert.rejects(f.owner.close(),/COMPOSITION_RENDER_RELEASE_UNCONFIRMED/);
  assert.equal(f.owner.state.renderFailed,true);assert.equal(f.owner.state.owners,1);assert.equal(f.owner.state.retired,1);
  assert.equal(f.registrations.inspect().editableBorrowers,1);assert.deepEqual(totals(),held);
  f.setRender(async()=>{});await f.close();assert.equal(f.owner.state.owners,0);assert.equal(f.owner.state.retired,0);
  assert.equal(f.registrations.inspect().editableBorrowers,0);assert.throws(()=>render.pin(),/COMPOSITION_OWNER_RELEASED/);assert.deepEqual(totals(),zero);
 }finally{release();f.setRender(async()=>{});}
});

test('Composition lifetime admits at most 96 retained generations and refuses before exposing a successor',async()=>{
 const f=lifetimeFixture(),gate=deferred();f.setRender(()=>gate.promise);const values=[];
 for(let i=0;i<96;i++)values.push(f.owned('same-draft',1));const before=totals();assert.throws(()=>f.owner.ensure(),/COMPOSITION_MODEL_CAPACITY/);assert.equal(f.owner.state.owners,96);assert.deepEqual(totals(),before);
 for(const value of values)value.release();gate.resolve();await flush();assert.equal(f.owner.state.owners,0);
});

test('Composition lifetime bounds 32 actual concurrent actions and refunds only the final pin',async()=>{
 const f=lifetimeFixture(),value=f.owned(),actions=Array.from({length:32},()=>f.action()),before=totals();assert.throws(()=>f.owner.action(),/COMPOSITION_ACTION_CAPACITY/);assert.deepEqual(totals(),before);
 value.release();await flush();for(const release of actions.slice(0,-1))release();assert.equal(f.owner.state.owners,1);assert.equal(f.registrations.inspect().editableBorrowers,1);
 actions.at(-1)();assert.equal(f.owner.state.owners,0);assert.equal(f.registrations.inspect().editableBorrowers,0);
});

test('failed Composition render and close preserve actual owners until a successful close retry',async()=>{
 const f=lifetimeFixture(),failure=Error('host commit failed');f.setRender(async()=>{throw failure;});const value=f.owned(),before=totals();value.release();await flush();
 await assert.rejects(f.owner.close(),/COMPOSITION_RENDER_RELEASE_UNCONFIRMED/);assert.equal(f.owner.state.renderFailed,true);assert.equal(f.owner.state.owners,1);assert.deepEqual(totals(),before);assert.equal(f.registrations.inspect().editableBorrowers,1);
 f.setRender(async()=>{});await f.close();assert.deepEqual(totals(),zero);
});

test('Composition lifetime group preflight is atomic before owner publication',async()=>{
 const f=lifetimeFixture(),values=[];for(let i=0;i<94;i++)values.push(f.owned('same-draft',1));const before=totals();assert.throws(()=>f.owner.ensure(3),/COMPOSITION_MODEL_CAPACITY/);assert.equal(f.owner.state.owners,94);assert.deepEqual(totals(),before);for(const value of values)value.release();await flush();
});

test('Composition registers the editable draft before publishing any new accepted state',async t=>{
 const f=fixture(t);await f.initial();const state={draft:f.controller.c,base:f.controller.base,layers:f.controller.layers,accepted:f.controller.accepted,key:f.controller.key},register=f.editor.registerDraft;
 f.editor.view.document={id:'successor-document',revision:'1',width:360,height:200};f.editor.registerDraft=()=>{throw Error('registration refused');};
 await assert.rejects(f.controller.sync(),/registration refused/);assert.equal(f.controller.c,state.draft);assert.equal(f.controller.base,state.base);assert.equal(f.controller.layers,state.layers);assert.equal(f.controller.accepted,state.accepted);assert.equal(f.controller.key,state.key);f.editor.registerDraft=register;
});

test('Composition mutation keeps the previous rendered allowance until host commit',async t=>{
 const f=fixture(t);await f.initial();await flush();const gate=deferred(),previous=f.controller.payloads.get('draft');f.host.updateComplete=gate.promise;
 f.controller.admitMutation(100);assert.notEqual(f.controller.payloads.get('draft'),previous);await flush();assert.ok(f.controller.lifecycle.retiredOwners>0);const held=totals();assert.ok(held.prompt>0);
 gate.resolve();await flush();assert.equal(f.controller.lifecycle.retiredOwners,0);assert.ok(totals().prompt<held.prompt);
});

test('Composition close waits for real host clear and retains draft registration on failed clear',async t=>{
 const f=fixture(t);await f.initial();const failed=Promise.reject(Error('failed clear'));void failed.catch(()=>{});f.host.updateComplete=failed;
 await assert.rejects(f.controller.releaseDocument(),/COMPOSITION_RELEASE_INCOMPLETE/);assert.ok(f.registrations.inspect().editableBorrowers>0);assert.ok(totals().prompt>0);
 f.host.updateComplete=Promise.resolve();await f.controller.releaseDocument();assert.equal(f.registrations.inspect().editableBorrowers,0);assert.deepEqual(totals(),zero);
});

function controlEvent(target){return {currentTarget:target,composedPath:()=>[target],detail:{},defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};}
test('Composition native refusal retains only native field input and blocks close until exact retry saves',async t=>{
 const f=fixture(t);await f.initial();const model=f.controller.c,old=model.scene,target={id:'composition-scene',value:'Unsaved native field input',isConnected:true};
 const pressure=allocationLedger.reserve({owner:'composition-input-refusal-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes});
 try{f.controller.input(controlEvent(target),value=>model.scene=value);await flush();assert.equal(model.scene,old);assert.equal(target.value,'Unsaved native field input');assert.equal(f.controller.fieldValue(target.id,old),Symbol.for('fixture.noChange'));assert.throws(()=>f.registrations.assertSaved('document'),/Draft workspace is full/);}finally{pressure.release();}
 f.controller.input(controlEvent(target),value=>model.scene=value);await flush();assert.equal(model.scene,target.value);assert.equal(f.controller.refusedControl,null);assert.doesNotThrow(()=>f.registrations.assertSaved('document'));
});

test('Composition queued button obeys final native veto and is canceled with its owner on close',async t=>{
 const f=fixture(t);await f.initial();let calls=0;const event=controlEvent({isConnected:true});f.controller.button(event,()=>{calls++;});event.defaultPrevented=true;
 await new Promise(resolve=>setTimeout(resolve,0));assert.equal(calls,0);assert.equal(f.controller.lifecycle.pendingPins,0);
 f.controller.button(controlEvent({isConnected:true}),()=>{calls++;});assert.equal(f.controller.lifecycle.queuedActions,1);await f.controller.releaseDocument();assert.equal(calls,0);assert.equal(f.controller.lifecycle.queuedActions,0);assert.deepEqual(totals(),zero);
});


test('ordinary Composition generation saturation retains slots for the render that drains it',async t=>{
 const f=fixture(t);await f.initial();f.controller.add('obj');f.controller.c.elements[0].bounds={mode:'literal',value:{rect:[0,0,10,10],transform:[1,0,0,1,0,0]}};await flush();const gate=deferred();f.host.updateComplete=gate.promise;
 while(f.controller.lifecycle.owners<90)f.controller.admitMutation(1);
 const before=f.controller.c;assert.throws(()=>f.controller.admitMutation(1),/COMPOSITION_MODEL_CAPACITY/);assert.equal(f.controller.c,before);
 assert.doesNotThrow(()=>f.controller.request());const inspector=f.controller.inspector();assert.ok(f.controller.payloads.has('render-box-projection'));assert.equal(JSON.stringify(inspector).includes('COMPOSITION_MODEL_CAPACITY'),false);assert.doesNotThrow(()=>f.controller.dialog());assert.ok(f.controller.lifecycle.owners<=96);gate.resolve();await flush();assert.ok(f.controller.lifecycle.owners<90);assert.doesNotThrow(()=>f.controller.admitMutation(1));
});

test('Composition has one pinned focus continuation and drains it after host completion',async t=>{
 const f=fixture(t);await f.initial();const gate=deferred();f.host.updateComplete=gate.promise;let calls=0;
 f.controller.focusAfter(()=>{calls++;});f.controller.focusAfter(()=>{calls+=10;});assert.equal(f.controller.lifecycle.pendingPins,1);
 let done=false;const closing=f.controller.releaseDocument().then(()=>{done=true;});await flush();assert.equal(done,false);gate.resolve();await closing;assert.equal(calls,0);assert.equal(f.controller.lifecycle.pendingPins,0);assert.deepEqual(totals(),zero);
});

test('Composition render admits derived native layer labels before constructing templates',async t=>{
 const f=fixture(t);await f.initial();await flush();const name='N'.repeat(70000);f.editor.view.image={layers:[{id:'native-layer',name}]};const before=allocationLedger.snapshot().byKind.control.cpuBytes;
 f.controller.request();assert.ok(allocationLedger.snapshot().byKind.control.cpuBytes-before>=name.length*16);
});


for(const named of [true,false])test('Composition '+(named?'identified':'stable anonymous')+' select retains a refused proposal until exact retry',async t=>{
 const f=fixture(t);await f.initial();const model=f.controller.c,label=named?'Prompt expansion':'Palette scope',current=()=>named?model.request.expansion:f.controller.paletteTarget,wanted=named?'Medium':'style',id=named?'composition-expansion':'';
 const template=()=>f.controller.choice(label,current(),named?[['None','None'],['Medium','Medium']]:[['element','Element'],['style','Style']],value=>{if(named)model.request.expansion=value;else f.controller.paletteTarget=value;},id);
 const first=template(),target={id:first.values[0],value:wanted,isConnected:true},prior=current();assert.ok(target.id);const pressure=allocationLedger.reserve({owner:'composition-select-refusal-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes});
 try{first.values[3](controlEvent(target));await flush();assert.equal(current(),prior);assert.equal(target.value,wanted);assert.equal(template().values[2],Symbol.for('fixture.noChange'));assert.throws(()=>f.registrations.assertSaved('document'),/Draft workspace is full/);}finally{pressure.release();}
 template().values[3](controlEvent(target));await flush();assert.equal(current(),wanted);assert.equal(f.controller.refusedControl,null);assert.doesNotThrow(()=>f.registrations.assertSaved('document'));
});


test('first refused clean Composition input keeps its exact draft authority across revision synchronization',async t=>{
 const f=fixture(t);await f.controller.sync();assert.equal(f.controller.dirty,false);const model=f.controller.c,id=f.controller.draftId,reads=f.reads.length,target={id:'composition-scene',value:'First unsaved input',isConnected:true};
 const pressure=allocationLedger.reserve({owner:'composition-clean-refusal-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes});
 try{f.controller.input(controlEvent(target),value=>model.scene=value);await flush();assert.equal(f.controller.dirty,false);assert.throws(()=>f.registrations.assertSaved('document'),/Draft workspace is full/);}finally{pressure.release();}
 f.editor.view.document={...f.editor.view.document,revision:'2'};await f.controller.sync();assert.equal(f.reads.length,reads);assert.equal(f.controller.draftId,id);assert.equal(f.controller.c,model);
 f.controller.input(controlEvent(target),value=>model.scene=value);await flush();assert.equal(model.scene,target.value);assert.equal(f.controller.draftId,id);assert.doesNotThrow(()=>f.registrations.assertSaved('document'));
});

function templateCallback(template,match){if(!template||typeof template!=='object')return undefined;if(template.strings){for(let i=0;i<template.values.length;i++)if(typeof template.values[i]==='function'&&match(template.strings,i))return template.values[i];}for(const value of Array.isArray(template)?template:template.values??[]){const found=templateCallback(value,match);if(found)return found;}return undefined;}
test('old connected Composition button and switch callbacks cannot act on a successor awaiting restore',async t=>{
 const f=fixture(t);await f.initial();f.controller.add('obj');const old=f.controller.c,element=old.elements[0],template=f.controller.inspector(),duplicate=templateCallback(template,(strings,i)=>strings[i+1].includes('>Duplicate semantic element<')),exclude=templateCallback(template,(strings,i)=>strings[i].includes('@en-change=')&&strings[i-1]?.includes('label="Exclude element from request"'));
 assert.equal(typeof duplicate,'function');assert.equal(typeof exclude,'function');f.controller.dirty=false;const next=structuredClone(old);next.id='successor-composition';next.scene='Successor';f.editor.view.document={id:'successor-document',revision:'1',width:360,height:200};f.setUI({drafts:[{id:'successor-saved',kind:'composition',documentId:'successor-document',status:'saved-unapplied',generation:'1',expectedDocumentRevision:'1'}]});const gate=deferred(),entered=deferred();
 f.setRead(async path=>{if(path.startsWith('/api/v1/ui/')){entered.resolve();return gate.promise;}return f.jsonResponse({composition:next,layers:[],bindings:{},revision:'1'});});const syncing=f.controller.sync();
 try{await boundary(syncing,entered);assert.notEqual(f.controller.c,old);const click=controlEvent({isConnected:true}),change=controlEvent({isConnected:true,checked:true});duplicate(click);exclude(change);await flush();assert.equal(click.defaultPrevented,true);assert.equal(change.defaultPrevented,true);assert.equal(old.elements.length,1);assert.equal(element.excluded,false);assert.equal(f.controller.c.elements.length,1);assert.equal(f.controller.c.elements[0].excluded,false);assert.equal(f.controller.lifecycle.queuedActions,0);
 }finally{gate.resolve(f.jsonResponse({graph:{composition:next},bindings:{}}));await syncing;}
});


test('queued Composition switch settlement rechecks the model owner before invoking old work',async t=>{
 const f=fixture(t);await f.initial();f.controller.add('obj');const old=f.controller.c,element=old.elements[0],template=f.controller.inspector(),exclude=templateCallback(template,(strings,i)=>strings[i].includes('@en-change=')&&strings[i-1]?.includes('label="Exclude element from request"'));assert.equal(typeof exclude,'function');
 const event=controlEvent({isConnected:true,checked:true});exclude(event);
 // Publish a separately admitted actual model before the native proposal's
 // microtask; no raw unowned graph is installed or hidden by the fixture.
 f.controller.c=f.controller.adopt('draft',cloneCompositionValue(old));await flush();assert.equal(event.defaultPrevented,true);assert.equal(element.excluded,false);assert.equal(f.controller.c.elements[0].excluded,false);assert.equal(f.controller.lifecycle.pendingPins,0);
});

// Typed-view successor: these use the real reader/ledger and controller, while
// HTTP generation and Lit/host commits remain explicit stand-ins above. They do
// not claim server persistence, native textarea rendering, or browser RSS proof.
const {readCompositionJSON,reserveCompositionRead}=await import(memoryURL);
const {readOwnedJSON}=await import(modelURL);
const {DRAFT_GRAPH_BYTES,COMPOSITION_DRAFT_VIEW_BYTES,COMPOSITION_VIEW_BYTES}=await import(compositionViewURL);
function boundedSavedGraph(encoding='escaped'){
 const composition=emptyComposition(360,200,'large-recovered');
 // Invalid authored text is deliberately recoverable, not semantic authority.
 composition.scene='Unapplied invalid scalar \ud800';
 const graph={composition,bindings:{},rawText:'',view:'composition',guides:true};
 const remaining=DRAFT_GRAPH_BYTES-Buffer.byteLength(JSON.stringify(graph));
 if(encoding==='ascii-scene')composition.scene+='x'.repeat(remaining);
 else graph.rawText='\u0001'.repeat(Math.floor(remaining/6))+'x'.repeat(remaining%6);
 assert.equal(Buffer.byteLength(JSON.stringify(graph)),DRAFT_GRAPH_BYTES);
 return graph;
}
function typedResponse(value,status=200){const text=JSON.stringify(value);return new Response(text,{status,headers:{'content-length':String(Buffer.byteLength(text)),'content-type':'application/json'}});}
function readView(response,kind='draft',owns=()=>true,signal=new AbortController().signal){return readCompositionJSON(response,owns,signal,kind,reserveCompositionRead());}

test('exact 8 MiB recoverable graph uses CONTROL ownership without consuming the prompt partition',async()=>{
 const graph=boundedSavedGraph(),value={graph,bindings:{}},wire=Buffer.byteLength(JSON.stringify(value));
 assert(wire>DRAFT_GRAPH_BYTES&&wire<COMPOSITION_DRAFT_VIEW_BYTES);
 const before=allocationLedger.snapshot(),pressure=allocationLedger.reserve({owner:'composition-view-prompt-partition-full',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-before.promptBytes});let retained;
 try{retained=await readView(typedResponse(value));assert.deepEqual(retained.value,value);const held=allocationLedger.snapshot();assert.equal(held.promptBytes,ALLOCATION_LIMITS.promptBytes);assert.equal(held.byKind.control.cpuBytes-before.byKind.control.cpuBytes,compositionPayloadBytes(value));}
 finally{retained?.owner.release();pressure.release();}
 assert.deepEqual(totals(),zero);
});

test('accepted view reads bounded native layer text above 16 MiB while draft and generic JSON limits remain distinct',async()=>{
 const value={composition:null,bindings:{},revision:'1',layers:Array.from({length:50},(_,i)=>({id:'text-'+i,version:'1',kind:'text',text:'\u0001'.repeat(65536),appearance:'',bounds:{rect:[0,0,1,1],transform:[1,0,0,1,0,0]}}))};
 const wire=Buffer.byteLength(JSON.stringify(value));assert(wire>16*1024**2&&wire<COMPOSITION_VIEW_BYTES);
 const before=allocationLedger.snapshot(),retained=await readView(typedResponse(value),'accepted');
 try{assert.equal(retained.value.layers.length,50);assert.equal(retained.value.layers[49].text,value.layers[49].text);assert.equal(allocationLedger.snapshot().promptBytes,before.promptBytes);assert.equal(allocationLedger.snapshot().byKind.control.cpuBytes-before.byKind.control.cpuBytes,compositionPayloadBytes(value));}finally{retained.owner.release();}
 let canceled=0;const denied=()=>new Response(new ReadableStream({cancel(){canceled++;}}),{headers:{'content-length':String(wire)}});
 await assert.rejects(readView(denied(),'draft'),/COMPOSITION_CONTENT_SIZE/);
 await assert.rejects(readOwnedJSON(async()=>denied(),'/unrelated-control',{owner:'composition-test-generic-read'}),/PROMPT_CONTENT_SIZE/);
 assert.equal(canceled,2);assert.deepEqual(totals(),zero);
});

for(const [kind,status,limit] of [['draft',200,COMPOSITION_DRAFT_VIEW_BYTES],['accepted',200,COMPOSITION_VIEW_BYTES],['draft',400,65536]])test('typed '+kind+' status '+status+' refuses excessive length before payload allocation and drains its admitted handle',async()=>{
 const cancel=deferred(),entered=deferred();let reads=0;
 const reader={read(){reads++;throw Error('Over-limit payload must not be read');},cancel(){entered.resolve();return cancel.promise;},releaseLock(){}};
 const response={ok:status===200,headers:new Headers({'content-length':String(limit+1)}),body:{getReader:()=>reader}};
 const prior=allocationLedger.snapshot(),pending=readView(response,kind);void pending.catch(()=>{});
 try{await entered.promise;assert.equal(reads,0);const held=allocationLedger.snapshot();assert.equal(held.cpuBytes,prior.cpuBytes);assert.equal(held.byKind.control.handles,prior.byKind.control.handles+2);cancel.resolve();await assert.rejects(pending,/COMPOSITION_CONTENT_SIZE/);}finally{cancel.resolve();await pending.catch(()=>{});}
 assert.deepEqual(totals(),zero);
});

for(const scenario of ['raw-admission','parse-admission'])test('typed view '+scenario+' capacity refusal releases every admitted response owner',async()=>{
 const bytes=Buffer.from('{"value":"retained"}'),remaining=scenario==='raw-admission'?bytes.length-1:bytes.length+1;
 const pressure=allocationLedger.reserve({owner:'composition-view-control-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-allocationLedger.snapshot().cpuBytes-remaining});
 let reads=0,cancels=0,unlocks=0;
 const reader={async read(){reads++;return reads===1?{done:false,value:bytes}:{done:true};},async cancel(){cancels++;},releaseLock(){unlocks++;}};
 const response={ok:true,headers:new Headers({'content-length':String(bytes.length)}),body:{getReader:()=>reader}};
 try{await assert.rejects(readView(response),/ALLOCATION_BUDGET/);assert.equal(reads,scenario==='raw-admission'?0:2);assert.equal(cancels,scenario==='raw-admission'?1:0);assert.equal(unlocks,1);}finally{pressure.release();}
 assert.deepEqual(totals(),zero);
});

for(const [name,response,pattern] of [
 ['invalid UTF8',()=>new Response(new Uint8Array([0xff]),{headers:{'content-length':'1'}}),/encoded data|encoding|UTF-8/i],
 ['malformed JSON',()=>new Response('{',{headers:{'content-length':'1'}}),/JSON/],
 ['short body',()=>new Response('{}',{headers:{'content-length':'3'}}),/COMPOSITION_CONTENT_SIZE/],
 ['long body',()=>new Response('{}',{headers:{'content-length':'1'}}),/COMPOSITION_CONTENT_SIZE/],
 ['missing length',()=>new Response('{}'),/COMPOSITION_CONTENT_SIZE/],
 ['ordinary error DTO',()=>typedResponse({error:{code:'COMPOSITION_STALE_FIXTURE'}},409),/COMPOSITION_STALE_FIXTURE/],
])test('typed Composition response '+name+' refuses without leaking control payloads',async()=>{await assert.rejects(readView(response()),pattern);assert.deepEqual(totals(),zero);});

for(const encoding of ['escaped','ascii-scene'])test('controller recovers exact 8 MiB '+encoding+' graph as unapplied owned data and renders under CONTROL ownership',async t=>{
 const f=fixture(t),graph=boundedSavedGraph(encoding);f.setUI({drafts:[{id:'large-saved',kind:'composition',documentId:'document',status:'saved-unapplied',generation:'9',expectedDocumentRevision:'1'}]});
 f.setRead(async path=>path.startsWith('/api/v1/ui/')?typedResponse({graph,bindings:{}}):typedResponse({composition:null,layers:[],bindings:{},revision:'1'}));
 await f.controller.sync();assert.deepEqual(f.controller.c,graph.composition);assert.equal(f.controller.convertText,graph.rawText);assert.equal(f.controller.draftId,'large-saved');assert.equal(f.controller.dirty,true);assert.equal(f.controller.accepted,null);assert.equal(f.commands.length,0);assert.equal(f.stages.length,0);assert.equal(f.editor.draftOwner.drafts.size,0);
 if(encoding==='escaped')assert.throws(()=>f.controller.validate(),/STRING_LIMIT/);
 const prompt=allocationLedger.snapshot().promptBytes;assert.ok(f.controller.request());assert.equal(allocationLedger.snapshot().promptBytes,prompt);
 assert.ok(f.controller.inspector());assert.ok(f.controller.dialog());
 assert.ok(allocationLedger.snapshot().byKind.control.cpuBytes-baseline.byKind.control.cpuBytes>=compositionPayloadBytes({graph,bindings:{}}));
 await f.close();fixtures.delete(f);assert.deepEqual(totals(),zero);
});

test('document close during large saved-view body cancels and drains before refunding CONTROL bytes',async t=>{
 const f=fixture(t),graph=boundedSavedGraph(),text=JSON.stringify({graph,bindings:{}}),cancel=deferred(),entered=deferred();
 const response=new Response(new ReadableStream({pull(){entered.resolve();},cancel(){return cancel.promise;}}),{headers:{'content-length':String(Buffer.byteLength(text))}});
 f.setUI({drafts:[{id:'large-saved',kind:'composition',documentId:'document',status:'saved-unapplied',generation:'9',expectedDocumentRevision:'1'}]});
 f.setRead(async path=>path.startsWith('/api/v1/ui/')?response:typedResponse({composition:null,layers:[],bindings:{},revision:'1'}));
 const syncing=f.controller.sync();void syncing.catch(()=>{});let closing;
 try{await entered.promise;await flush();assert.equal(f.reads.length,2);assert.ok(allocationLedger.snapshot().byKind.control.cpuBytes-baseline.byKind.control.cpuBytes>=Buffer.byteLength(text));
  let closed=false;closing=f.controller.releaseDocument().then(()=>{closed=true;});await flush();assert.equal(closed,false);assert.equal(f.controller.c,null);assert.ok(allocationLedger.snapshot().byKind.control.cpuBytes>baseline.byKind.control.cpuBytes);
  cancel.resolve();await syncing;await closing;assert.equal(closed,true);assert.equal(f.controller.c,null);assert.equal(f.commands.length,0);assert.equal(f.controller.lifecycle.pendingOperations,0);
 }finally{cancel.resolve();await syncing.catch(()=>{});await closing;}
 await f.close();fixtures.delete(f);assert.deepEqual(totals(),zero);
});

test('typed Composition cleanup retains its actual CONTROL reader lease until unlock retry succeeds',async()=>{
 const {PromptReaderCleanupError}=await import(promptURL);let attempts=0,failure;
 const reader={async read(){throw Error('composition view stream failed');},async cancel(){},releaseLock(){if(++attempts===1)throw Error('composition view unlock failed');}};
 const response={ok:true,headers:new Headers({'content-length':'8'}),body:{getReader:()=>reader}};
 const before=allocationLedger.snapshot();
 try{await assert.rejects(readView(response),error=>{failure=error;return error instanceof PromptReaderCleanupError;});assert.equal(failure.resource.response,response);assert.equal(failure.resource.retainedReader,reader);assert.equal(failure.cancellationFailed,false);assert.equal(allocationLedger.snapshot().byKind.control.cpuBytes-before.byKind.control.cpuBytes,8);assert.equal(allocationLedger.snapshot().promptBytes,before.promptBytes);assert.equal(allocationLedger.snapshot().unusedHandles-before.unusedHandles,2);}
 finally{await failure?.retry();}
 assert.deepEqual(totals(),zero);
});

test('Composition render still refuses global CONTROL pressure before building a template or replacing its model',async t=>{
 const f=fixture(t);await f.initial();const draft=f.controller.c,prior=f.controller.payloads.get('render-request');let built=false;
 const pressure=allocationLedger.reserve({owner:'composition-render-control-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-allocationLedger.snapshot().cpuBytes});
 try{assert.throws(()=>f.controller.render('request',()=>{built=true;return 'unreachable';}),/ALLOCATION_BUDGET/);assert.equal(built,false);assert.equal(f.controller.c,draft);assert.equal(f.controller.payloads.get('render-request'),prior);assert.equal(f.commands.length,0);}
 finally{pressure.release();}
});


test('typed Composition JSON does not masquerade as raw-caption read evidence',async()=>{
 const {compositionObservations}=await import(observationURL),{readCompositionBytes}=await import(memoryURL);
 const first=compositionObservations.readSnapshot();let cursor;try{cursor=first.value.cursor;}finally{first.release();}
 const json=await readView(typedResponse({graph:{},bindings:{}}));json.owner.release();
 const afterJSON=compositionObservations.readSnapshot();try{assert.equal(afterJSON.value.records.filter(row=>row.sequence>cursor&&row.kind==='raw-read').length,0);}finally{afterJSON.release();}
 const raw=await readCompositionBytes(new Response('{}',{headers:{'content-length':'2'}}),2,()=>true,new AbortController().signal);raw.owner.release();
 const afterRaw=compositionObservations.readSnapshot();try{const rows=afterRaw.value.records.filter(row=>row.sequence>cursor&&row.kind==='raw-read');assert.equal(rows.length,1);assert.equal(rows[0].operation,'stream-read');assert.equal(rows[0].receivedBytes,2);assert.equal(rows[0].sourceBytes,2);}finally{afterRaw.release();}
 assert.deepEqual(totals(),zero);
});


// Automatic synchronization uses the real controller and owned response reader.
// Repeated calls below stand for unrelated shell updates; no timer or error
// publisher is replaced in production. The original rejection is still visible.
const refusedCompositionResponse=()=>{
 const text=JSON.stringify({error:{code:'STORAGE_FULL'}});
 return new Response(text,{status:507,headers:{'content-length':String(Buffer.byteLength(text))}});
};
const recoverComposition=f=>{f.editor.view.ready=false;return f.controller.sync().then(()=>{f.editor.view.ready=true;return f.controller.sync();});};

test('one Composition 507 remains visible without automatic read or rejection amplification',async t=>{
 const f=fixture(t),errors=[],gate=deferred(),entered=deferred();f.setRead(async()=>{entered.resolve();return gate.promise;});
 const synchronize=()=>f.controller.sync().catch(error=>{errors.push(error.message);});
 const original=synchronize();await boundary(original,entered);const pending=totals();
 await Promise.all(Array.from({length:16},()=>synchronize()));assert.equal(f.reads.length,1);assert.deepEqual(errors,[]);assert.deepEqual(totals(),pending);
 gate.resolve(refusedCompositionResponse());await original;f.setRead(async()=>refusedCompositionResponse());assert.deepEqual(errors,['STORAGE_FULL']);assert.equal(f.reads.length,1);assert.equal(f.controller.c,null);const retained=totals();
 for(let i=0;i<32;i++){f.editor.view.message='Unrelated status '+i;f.host.requestUpdate();await synchronize();}
 assert.equal(f.reads.length,1);assert.deepEqual(errors,['STORAGE_FULL']);assert.deepEqual(totals(),retained);assert.equal(f.controller.lifecycle.pendingOperations,0);
 await assert.rejects(recoverComposition(f),/STORAGE_FULL/);assert.equal(f.reads.length,2);
 await f.controller.sync();assert.equal(f.reads.length,2,'A failed explicit recovery is latched again');
 f.setRead(async()=>f.jsonResponse({composition:null,layers:[],bindings:{},revision:'1'}));await recoverComposition(f);
 assert.equal(f.reads.length,3);assert.equal(f.controller.base.id,'document');assert.equal(f.controller.ownsModel(),true);
 await f.controller.sync();assert.equal(f.reads.length,3,'Successful current synchronization remains deduplicated');
});

test('Composition snapshot admission failure is suppressed before another reservation or transport',async t=>{
 const f=fixture(t),pressure=allocationLedger.reserve({owner:'composition-auto-sync-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes});
 try{await assert.rejects(f.controller.sync(),/PROMPT_MEMORY_BUDGET/);const retained=totals();await f.controller.sync();assert.equal(f.reads.length,0);assert.deepEqual(totals(),retained);}finally{pressure.release();}
 await f.controller.sync();assert.equal(f.reads.length,0,'Free capacity alone is not an implicit retry');
 await recoverComposition(f);assert.equal(f.reads.length,1);assert.equal(f.controller.base.id,'document');
});

test('every Composition recovery authority change admits one new automatic attempt',async t=>{
 for(const boundary of ['connection','identity','draft-owner','session','document','revision','document-epoch']){
  const f=fixture(t);f.editor.documentEpoch=1;f.setRead(async()=>refusedCompositionResponse());await assert.rejects(f.controller.sync(),/STORAGE_FULL/);
  if(boundary==='connection')f.editor.session={...f.editor.session};
  if(boundary==='identity')f.editor.session.identity=()=> 'next-client';
  if(boundary==='draft-owner')f.editor.draftOwner={drafts:new Map()};
  if(boundary==='session')f.editor.sessionId='next-session';
  if(boundary==='document')f.editor.view.document={...f.editor.view.document,id:'next-document'};
  if(boundary==='revision')f.editor.view.document={...f.editor.view.document,revision:'2'};
  if(boundary==='document-epoch')f.editor.documentEpoch++;
  await assert.rejects(f.controller.sync(),/STORAGE_FULL/,boundary);await f.controller.sync();assert.equal(f.reads.length,2,boundary);
 }
});

test('pending Composition synchronization deduplicates updates and a stale rejection cannot fence its successor',async t=>{
 const f=fixture(t),gate=deferred(),entered=deferred();f.editor.documentEpoch=1;
 f.setRead(async()=>{entered.resolve();return gate.promise;});const prior=f.controller.sync();void prior.catch(()=>{});
 try{
  await boundary(prior,entered);await Promise.all(Array.from({length:16},()=>f.controller.sync()));assert.equal(f.reads.length,1);
  f.editor.view.document={...f.editor.view.document,id:'successor-document'};f.editor.documentEpoch++;
  f.setRead(async()=>f.jsonResponse({composition:null,layers:[],bindings:{},revision:'1'}));await f.controller.sync();assert.equal(f.reads.length,2);const successor=f.controller.c;
  gate.reject(Error('old refused read'));await prior;await f.controller.sync();
  assert.equal(f.controller.c,successor);assert.equal(f.controller.base.id,'successor-document');assert.equal(f.controller.syncFailure,null);assert.equal(f.reads.length,2);
 }finally{gate.resolve(f.jsonResponse({composition:null,layers:[],bindings:{},revision:'1'}));await prior.catch(()=>{});}
});

test('a recovery readiness transition supersedes an in-flight same-owner Composition read',async t=>{
 const f=fixture(t),gate=deferred(),entered=deferred();f.setRead(async()=>{entered.resolve();return gate.promise;});const prior=f.controller.sync();void prior.catch(()=>{});
 try{
  await boundary(prior,entered);f.editor.view.ready=false;await f.controller.sync();f.editor.view.ready=true;
  f.setRead(async()=>f.jsonResponse({composition:null,layers:[],bindings:{},revision:'1'}));await f.controller.sync();assert.equal(f.reads.length,2);const successor=f.controller.c;
  gate.reject(Error('superseded recovery read'));await prior;await f.controller.sync();assert.equal(f.controller.c,successor);assert.equal(f.controller.syncFailure,null);assert.equal(f.reads.length,2);
 }finally{gate.resolve(f.jsonResponse({composition:null,layers:[],bindings:{},revision:'1'}));await prior.catch(()=>{});}
});

test('failed saved Composition restoration retries the exact unchanged interim model after recovery or revision change',async t=>{
 for(const change of ['recovery','revision']){
  const f=restoringFixture(t),initial=f.controller.sync();void initial.catch(()=>{});
  try{
   await boundary(initial,f.entered);const interim=f.controller.c;assert(interim);f.gate.reject(Error('saved Composition read failed'));await assert.rejects(initial,/saved Composition read failed/);
   await f.controller.sync();assert.equal(f.reads.length,2);assert.equal(f.controller.c,interim);
   f.setRead(async path=>path.startsWith('/api/v1/ui/')?f.response():f.jsonResponse({composition:null,layers:[],bindings:{},revision:f.editor.view.document.revision}));
   if(change==='recovery')await recoverComposition(f);else{f.editor.view.document={...f.editor.view.document,revision:'2'};await f.controller.sync();}
   assert.equal(f.reads.length,4,change);assert.equal(f.controller.c.scene,'Saved checkpoint scene');assert.equal(f.controller.draftId,'saved-draft');assert.equal(f.controller.base.revision,'1','Restored draft retains its saved revision for explicit review');assert.equal(f.controller.restoreRetry,null);
  }finally{f.gate.resolve(f.response());await initial.catch(()=>{});}
 }
});

test('a failed saved Composition read never overwrites later edits to the interim draft',async t=>{
 const f=restoringFixture(t),initial=f.controller.sync();void initial.catch(()=>{});
 try{
  await boundary(initial,f.entered);f.gate.reject(Error('saved Composition read failed'));await assert.rejects(initial,/saved Composition read failed/);
  const interim=f.controller.c;interim.scene='Typed after failed restore';f.controller.touch();assert.equal(f.controller.dirty,true);
  f.setRead(async()=>{throw Error('Must retain the edited interim draft');});await recoverComposition(f);
  assert.equal(f.reads.length,2);assert.equal(f.controller.c,interim);assert.equal(f.controller.c.scene,'Typed after failed restore');assert.equal(f.controller.dirty,true);assert.equal(f.controller.restoreRetry,null);
 }finally{f.gate.resolve(f.response());await initial.catch(()=>{});}
});

test('Composition release drains a pending automatic read and does not retain its failure latch',async t=>{
 const f=fixture(t),gate=deferred(),entered=deferred();f.setRead(async()=>{entered.resolve();return gate.promise;});const initial=f.controller.sync();void initial.catch(()=>{});let closing;
 try{
  await boundary(initial,entered);let closed=false;closing=f.controller.releaseDocument().then(()=>{closed=true;});await flush();assert.equal(closed,false);
  gate.reject(Error('released read'));await initial;await closing;assert.equal(f.controller.syncFailure,null);assert.equal(f.controller.restoreRetry,null);assert.equal(f.controller.c,null);
  f.setRead(async()=>f.jsonResponse({composition:null,layers:[],bindings:{},revision:'1'}));await f.controller.sync();assert.equal(f.reads.length,2,'A new document lifecycle can recover');
  await f.controller.dispose();await f.controller.sync();assert.equal(f.reads.length,2,'Disposed controllers never retry');
 }finally{gate.resolve(f.jsonResponse({composition:null,layers:[],bindings:{},revision:'1'}));await initial.catch(()=>{});await closing;}
});

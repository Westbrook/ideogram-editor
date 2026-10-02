// Actual dialog controllers, ControlAdapter, model owners and shared allocation
// ledger. Lit templates/DOM painting and EditorClient operations are doubles.
// Authored source only; native browser behavior is covered by the J1 campaign.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {allocationsURL,promptMemoryURL} from '../owned-preview-module.mjs';
const root=process.env.J1_OWNERSHIP_SOURCE_ROOT??'.',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function source(path,imports={},staged=false){const file=(staged?root:'.')+'/'+path;let code=(await transformWithOxc(await readFile(file,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const lit=data('export const nothing=null;export const html=(strings,...values)=>({strings,values});'),repeat=data('export const repeat=(items,_key,render)=>items.map(render);');
const models=await source('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptMemoryURL});
const memory=await source('src/ui/dialog-ownership.ts',{'../observability/model-memory.js':models},true),adapter=await source('src/ui/adapters.ts');
const protocol=await source('src/protocol/document-creation.ts');
const imports={'lit':lit,'lit/directives/repeat.js':repeat,'../observability/model-memory.js':models,'./dialog-ownership.js':memory,'./adapters.js':adapter,'../protocol/document-creation.js':protocol};
const {NewDocumentControls}=await import(await source('src/ui/new-document.ts',imports,true)),{CommandSearch}=await import(await source('src/ui/command-search.ts',imports,true));
const {DialogOwnership}=await import(memory),{allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL);
const baseline=allocationLedger.snapshot(),totals=()=>{const s=allocationLedger.snapshot();return ['cpuBytes','handles','activeRecords'].map(key=>s[key]-baseline[key]);};
const fixtures=new Set(),gates=new Set(),leases=new Set();
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;}),value={promise,settled:false,resolve(v){value.settled=true;gates.delete(value);resolve(v);},reject(e){value.settled=true;gates.delete(value);reject(e);}};gates.add(value);void promise.catch(()=>{});return value;}
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();},tick=async()=>{await new Promise(resolve=>setTimeout(resolve,5));await flush();};
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await tick();}assert.fail('Expected actual dialog boundary was not reached');};
function event(value=''){const node={value,isConnected:true,focus(){}};return {currentTarget:node,composedPath:()=>[node],timeStamp:0,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};}
function handler(template,marker,attribute='@click='){
  if(!template||typeof template!=='object')return;
  if(template.strings){const start=template.strings.findIndex(s=>s.includes(marker));if(start>=0)for(let i=start;i<template.strings.length;i++)if(template.strings[i].includes(attribute)){assert.equal(typeof template.values[i],'function');return template.values[i];}}
  for(const nested of Array.isArray(template)?template:template.values??[]){const value=handler(nested,marker,attribute);if(value)return value;}
}
class Host extends EventTarget{
 updateComplete=Promise.resolve();throwUpdate=false;gate=null;focuses=0;shows=0;
 requestUpdate(){if(this.throwUpdate)throw Error('HOST_UPDATE_FAILED');this.updateComplete=this.gate?.promise??Promise.resolve();}
 querySelector(){return {isConnected:true,focus:()=>{this.focuses++;},show:()=>{this.shows++;}};}
 querySelectorAll(){return [];}
}
function fixture(kind){
 const host=new Host(),errors=[],created=[],called=[];let create=async(...args)=>{created.push(args);},commands=[{id:'new-document',label:'New document',description:'Create a document',disabledReason:'',run:async()=>{called.push('new-document');}}],panels=async()=>{};
 const editor={session:{identity:()=> 'identity'},sessionId:'session',view:{ready:true,busy:false,pending:[],pendingCreate:false,document:{id:'doc',revision:'1'},selected:[]},fail:error=>{errors.push(error);},run:async(_label,work)=>{try{await work();}catch(error){errors.push(error);}},create:(...args)=>create(...args)};
 let controller;controller=kind==='new'?new NewDocumentControls(host,editor,()=>controller.cancel()):new CommandSearch(host,editor,()=>commands,()=>panels());
 const value={host,editor,controller,errors,created,called,setCreate(fn){create=fn;},setCommands(value){commands=value;},setPanels(fn){panels=fn;},async open(){if(kind==='new')controller.begin();else await controller.open({isConnected:true,focus(){}});},template(){return kind==='new'?controller.fields():controller.render();}};
 fixtures.add(value);return value;
}
test.afterEach(async()=>{for(const lease of leases)lease.release();leases.clear();for(const gate of [...gates])gate.resolve();for(const f of fixtures){f.host.throwUpdate=false;f.host.gate=null;f.host.updateComplete=Promise.resolve();}await tick();const outcomes=await Promise.allSettled([...fixtures].map(f=>f.controller.dispose()));fixtures.clear();for(const result of outcomes)assert.equal(result.status,'fulfilled',result.reason?.stack);assert.deepEqual(totals(),[0,0,0]);});

for(const kind of ['new','search'])test(kind+' retains the exact model after synchronous host retirement failure and releases on retry',async()=>{
 const f=fixture(kind);await f.open();f.template();f.host.throwUpdate=true;
 if(kind==='new')f.controller.cancel();else await assert.rejects(f.controller.close(),/COMMAND_SEARCH_RENDER_RELEASE_FAILED/);
 await flush();assert(f.controller.lifecycle.retiring>0);assert(f.controller.lifecycle.failed>0);assert(totals()[0]>0);
 f.host.throwUpdate=false;await f.controller.dispose();assert.equal(f.controller.lifecycle.models,0);assert.equal(f.controller.lifecycle.retiring,0);
});
for(const kind of ['new','search'])test(kind+' keeps a failed asynchronous Lit retirement charged until a successful replacement commit',async()=>{
 const f=fixture(kind);await f.open();f.template();const gate=deferred();f.host.gate=gate;
 const closing=kind==='new'?(f.controller.cancel(),Promise.resolve()):f.controller.close();void closing.catch(()=>{});gate.reject(Error('LIT_COMMIT_FAILED'));await closing.catch(()=>{});await flush();assert(f.controller.lifecycle.failed>0);assert(totals()[0]>0);
 f.host.gate=null;f.host.updateComplete=Promise.resolve();await f.controller.dispose();assert.equal(f.controller.lifecycle.models,0);
});
test('New Create respects an unresolved creation outside the visible pending page and reenables after it clears',async()=>{
 const f=fixture('new'),ordinary={request:{command:{body:{type:'SaveCheckpoint'}}}};f.editor.view.pending=[ordinary];f.editor.view.pendingCreate=true;await f.open();
 const draft=f.controller.draft,blocked=f.controller.createButton(),notice=()=>f.controller.fields().values.find(value=>value?.strings?.some(text=>text.includes('id="new-document-pending"')));
 assert.equal(blocked.values[0],true);assert.equal(blocked.values[1],'new-document-pending');assert.match(notice().strings.join(''),/A document creation receipt is unresolved/);
 handler(blocked,'id="new-document-create"')(event());await tick();assert.deepEqual(f.created,[]);assert.equal(f.controller.draft,draft);assert.equal(f.controller.opened,true);assert.equal(f.controller.lifecycle.pending,0);assert.equal(f.controller.lifecycle.actions,0);
 f.editor.view.pendingCreate=false;const enabled=f.controller.createButton();assert.equal(enabled.values[0],false);assert.equal(enabled.values[1],null);assert.equal(notice(),undefined);assert.equal(f.editor.view.pending[0],ordinary);
 handler(enabled,'id="new-document-create"')(event());await until(()=>f.created.length===1&&f.controller.lifecycle.pending===0);await tick();
 assert.deepEqual(f.created,[[1024,1024,{name:'Untitled document',background:{kind:'transparent'}}]]);assert.equal(f.controller.opened,false);assert.equal(f.controller.lifecycle.actions,0);assert.deepEqual(f.errors,[]);
});
test('New Create first UI-update failure ends its actual action pin and restores submission state',async()=>{
 const f=fixture('new');await f.open();const click=handler(f.controller.createButton(),'id="new-document-create"');f.host.throwUpdate=true;click(event());await tick();
 assert.equal(f.controller.lifecycle.pending,0);assert.equal(f.controller.lifecycle.actions,0);assert.equal(f.controller.submitting,false);assert.equal(f.created.length,0);assert(f.errors.some(error=>error.message==='HOST_UPDATE_FAILED'));
 f.host.throwUpdate=false;await f.controller.dispose();
});
for(const kind of ['new','search'])test(kind+' old rendered text callback cannot mutate a reopened dialog',async()=>{
 const f=fixture(kind);await f.open();const template=f.template(),change=handler(template,kind==='new'?'id="new-name"':'id="command-search-query"','@en-input=');
 if(kind==='new')f.controller.cancel();else await f.controller.close();await f.open();change(event('Old dialog input'));await flush();
 assert.equal(kind==='new'?f.controller.draft.name:f.controller.query,kind==='new'?'Untitled document':'');
});
test('old New Create and IME callbacks cannot submit or compose the reopened dialog',async()=>{
 const f=fixture('new');await f.open();const create=handler(f.controller.createButton(),'id="new-document-create"'),ime=handler(f.template(),'<section','@compositionstart=');f.controller.cancel();await f.open();create(event());ime();await tick();assert.equal(f.created.length,0);assert.equal(f.controller.composing,false);
});
test('old Search command and Close callbacks cannot execute or close a reopened search',async()=>{
 const f=fixture('search');await f.open();const old=f.template(),command=handler(old,'data-command-search-id='),close=handler(old,'slot="footer"');await f.controller.close();await f.open();command(event());close(event());await tick();assert.equal(f.called.length,0);assert.equal(f.controller.opened,true);
});
test('Search vetoed command and close proposals release their actual queued action pins',async()=>{
 const f=fixture('search');await f.open();const view=f.template(),command=event(),closing=event();closing.currentTarget.open=false;handler(view,'data-command-search-id=')(command);handler(view,'id="command-search-dialog"','@en-change=')(closing);command.preventDefault();closing.preventDefault();await tick();assert.equal(f.called.length,0);assert.equal(f.controller.opened,true);assert.equal(f.controller.lifecycle.actions,0);
});
for(const kind of ['new','search'])test(kind+' admission refusal keeps accepted input and reconciles the native control',async()=>{
 const f=fixture(kind);await f.open();const change=handler(f.template(),kind==='new'?'id="new-name"':'id="command-search-query"','@en-input='),before=kind==='new'?f.controller.draft.name:f.controller.query;
 const pressure=allocationLedger.reserve({owner:'j1-test-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-allocationLedger.snapshot().cpuBytes});leases.add(pressure);const ev=event('Refused full input');change(ev);await flush();assert.equal(kind==='new'?f.controller.draft.name:f.controller.query,before);assert.equal(ev.currentTarget.value,before);assert(f.errors.length>0);pressure.release();
});
test('New document action can invoke document-release cancellation while its own create promise is pending',async()=>{
 const f=fixture('new'),gate=deferred(),entered=deferred();await f.open();f.setCreate(async()=>{await f.controller.releaseView();entered.resolve();await gate.promise;});handler(f.controller.createButton(),'id="new-document-create"')(event());
 try{await until(()=>entered.settled);await entered.promise;assert.equal(f.controller.lifecycle.pending,1);assert.equal(f.controller.opened,false);assert(totals()[0]>0);gate.resolve();await until(()=>f.controller.lifecycle.pending===0);assert.equal(f.controller.lifecycle.actions,0);}finally{gate.resolve();}
});
test('New document view release waits for actual Lit retirement without reporting an early empty owner',async()=>{
 const f=fixture('new');await f.open();const gate=deferred();f.host.gate=gate;let complete=false;const release=f.controller.releaseView().then(()=>{complete=true;});
 try{await flush();assert.equal(complete,false);assert(f.controller.lifecycle.models>0);gate.resolve();await release;assert.equal(f.controller.lifecycle.models,0);}finally{gate.resolve();await release;}
});
test('Search repeated Close retries a failed retirement even after its visible owner was detached',async()=>{
 const f=fixture('search');await f.open();f.template();f.host.throwUpdate=true;await assert.rejects(f.controller.close(),/RENDER_RELEASE_FAILED/);assert(f.controller.lifecycle.models>0);f.host.throwUpdate=false;await f.controller.close();assert.equal(f.controller.lifecycle.models,0);assert.equal(f.controller.lifecycle.retiring,0);
});
test('Search command can close document resources without awaiting its own workspace action',async()=>{
 const f=fixture('search'),gate=deferred(),entered=deferred();f.setCommands([{id:'close-document',label:'Close document',description:'Close it',disabledReason:'',run:async()=>{await f.controller.close(false);entered.resolve();await gate.promise;}}]);await f.open();handler(f.template(),'data-command-search-id=')(event());
 try{await until(()=>entered.settled);await entered.promise;assert.equal(f.controller.opened,false);assert(f.controller.lifecycle.pending>0);gate.resolve();await until(()=>f.controller.lifecycle.pending===0);}finally{gate.resolve();}
});
test('Search owners retain only scalar identity tokens and preserve exact document/selection reference fences',async()=>{
 const f=fixture('search');await f.open();for(const key of ['image','orderedLayerIds'])Object.defineProperty(f.editor.view.document,key,{get(){throw Error('Full document inspected');}});const owner=f.controller.owner();assert.equal(typeof owner.document,'number');assert.equal(typeof owner.selected,'number');assert(f.controller.owns(owner));f.editor.view.selected=[];assert.equal(f.controller.owns(owner),false);const next=f.controller.owner();f.editor.view.document={id:'doc',revision:'1'};assert.equal(f.controller.owns(next),false);f.template();
});
test('Search render owner stays live across a pending Lit replacement',async()=>{
 const f=fixture('search');await f.open();f.template();const first=f.controller.rendered,gate=deferred();f.host.gate=gate;f.host.requestUpdate();f.template();assert.notEqual(f.controller.rendered,first);assert(f.controller.lifecycle.retiring>0);const unpin=first.pin();unpin();gate.resolve();await flush();assert.throws(()=>first.pin(),/DIALOG_MODEL_RELEASED/);
});
for(const kind of ['new','search'])test(kind+' disposal drains actual work and permanently refuses reopening',async()=>{
 const f=fixture(kind),entered=deferred(),gate=deferred();await f.open();
 if(kind==='new'){f.setCreate(async()=>{entered.resolve();await gate.promise;});handler(f.controller.createButton(),'id="new-document-create"')(event());}
 else{f.setCommands([{id:'wait',label:'Wait',description:'A bounded action',disabledReason:'',run:async()=>{entered.resolve();await gate.promise;}}]);handler(f.template(),'data-command-search-id=')(event());}
 let disposing;try{await until(()=>entered.settled);await entered.promise;let done=false;disposing=f.controller.dispose().then(()=>{done=true;});await flush();assert.equal(done,false);gate.resolve();await disposing;await assert.rejects(f.open(),/DISPOSED/);assert.equal(f.controller.lifecycle.actions,0);}finally{gate.resolve();await disposing;}
});
test('dialog owner refuses a thirty-third live model before its factory runs and preserves retired retry roots',async()=>{
 const host=new Host(),memory=new DialogOwnership(host,'j1-capacity'),values=[];let constructed=0;
 try{for(let i=0;i<32;i++)values.push(memory.create(64,()=>({value:i})));assert.throws(()=>memory.create(64,()=>{constructed++;return null;}),/DIALOG_MODEL_LIMIT/);assert.equal(constructed,0);host.throwUpdate=true;await assert.rejects(memory.retire(values[0]),/HOST_UPDATE_FAILED/);assert.equal(memory.lifecycle.models,32);host.throwUpdate=false;await memory.drain();assert.equal(memory.lifecycle.models,31);}finally{host.throwUpdate=false;await memory.drain();for(const value of values)value.release();}
});
test('dialog action admission is capped and final borrowed release controls the retired model lifetime',async()=>{
 const host=new Host(),memory=new DialogOwnership(host,'j1-actions'),model=memory.create(64,()=>({value:1})),releases=[];
 try{for(let i=0;i<8;i++)releases.push(memory.action([model],{i}));assert.throws(()=>memory.action([model],{}),/DIALOG_ACTION_LIMIT/);await memory.retire(model);assert.equal(memory.lifecycle.models,1);for(const release of releases)release();await memory.drain();assert.equal(memory.lifecycle.models,0);}finally{for(const release of releases)release();model.release();await memory.drain();}
});


test('New Create explains storage refusals while retaining its exact draft and unresolved original',async()=>{
 for(const code of ['waiting-for-resources','STORAGE_FULL','CAPACITY']){
  const f=fixture('new'),failure=Error(code),original={request:{command:{commandId:'retained-create-'+code,body:{type:'CreateDocument'}}}};await f.open();
  for(const [id,value,attribute]of [['new-name','Retain 東京','@en-input='],['new-width','3','@en-input='],['new-height','2','@en-input='],['new-background','solid','@en-change='],['new-background-color','#1153C9','@en-input=']]){handler(f.template(),'id="'+id+'"',attribute)(event(value));await flush();}
  const draft=f.controller.draft,document=f.editor.view.document;assert.deepEqual(draft,{name:'Retain 東京',width:'3',height:'2',background:'solid',color:'#1153C9'});
  Object.defineProperty(f.editor.view,'error',{get(){throw Error('Stale global diagnostic must not be sampled');}});
  f.setCreate(async(...args)=>{f.created.push(args);f.editor.view.pending=[original];f.editor.view.pendingCreate=true;throw failure;});
  handler(f.controller.createButton(),'id="new-document-create"')(event());await until(()=>f.errors.includes(failure)&&f.controller.lifecycle.pending===0);await tick();
  const message='Storage paused. Original bytes and command identities are retained. Free resources, then retry the same operation. Your dialog draft is retained.';
  assert.deepEqual(f.controller.issues,[{target:'new-document-create',message}]);assert(f.controller.fields().values.includes(f.controller.issues),'The actual validation summary receives the retained issue');
  assert.equal(f.controller.draft,draft);assert.equal(f.controller.opened,true);assert.equal(f.editor.view.document,document);assert.equal(f.editor.view.pending[0],original);assert.equal(f.editor.view.pendingCreate,true);assert.equal(f.host.focuses,1);assert.deepEqual(f.errors,[failure]);
  assert.deepEqual(f.created,[[3,2,{name:'Retain 東京',background:{kind:'solid',color:[17,83,201,255]}}]]);assert.equal(f.controller.submitting,false);assert.equal(f.controller.lifecycle.actions,0);
  const blocked=f.controller.createButton();assert.equal(blocked.values[0],true);assert.equal(blocked.values[1],'new-document-pending new-document-submit-error');handler(blocked,'id="new-document-create"')(event());await tick();assert.equal(f.created.length,1);assert.equal(f.controller.draft,draft);
 }
});
test('New Create keeps unknown and conflicting errors visible within the existing diagnostic bound',async()=>{
 for(const [failure,expected]of [[Error('UNKNOWN_CREATION_FAILURE'),'UNKNOWN_CREATION_FAILURE'],[Error('CONFLICT CAPACITY'),'CONFLICT CAPACITY'],[Error('CAPACITY '+ 'x'.repeat(1024)),('CAPACITY '+ 'x'.repeat(1024)).slice(0,512)],[Error('x'.repeat(512)+' waiting-for-resources'),'x'.repeat(512)],[null,'Document creation failed.']]){
  const f=fixture('new');await f.open();const draft=f.controller.draft;f.setCreate(async()=>{throw failure;});handler(f.controller.createButton(),'id="new-document-create"')(event());await until(()=>f.errors.includes(failure)&&f.controller.lifecycle.pending===0);await tick();
  assert.deepEqual(f.controller.issues,[{target:'new-document-create',message:expected+' Your dialog draft is retained.'}]);assert.equal(f.controller.draft,draft);assert.equal(f.controller.opened,true);assert.equal(f.host.focuses,1);assert.deepEqual(f.errors,[failure]);assert.equal(f.controller.lifecycle.actions,0);
 }
});
test('late New Create storage failures cannot publish into a successor or disposed dialog',async()=>{
 for(const change of ['reopened','identity','session','disposed']){
  const f=fixture('new'),entered=deferred(),gate=deferred(),failure=Error('waiting-for-resources');let disposal;
  await f.open();f.setCreate(async()=>{entered.resolve();await gate.promise;});handler(f.controller.createButton(),'id="new-document-create"')(event());
  try{
   await until(()=>entered.settled);await entered.promise;
   if(change==='reopened'){f.controller.cancel();await f.open();}
   if(change==='identity')f.editor.session.identity=()=> 'successor-identity';
   if(change==='session')f.editor.sessionId='successor-session';
   if(change==='disposed')disposal=f.controller.dispose();
   const draft=f.controller.draft,focuses=f.host.focuses;gate.reject(failure);await until(()=>f.controller.lifecycle.pending===0);await disposal;await tick();
   assert.equal(f.controller.draft,draft);assert.deepEqual(f.controller.issues,[]);assert.equal(f.host.focuses,focuses);assert.deepEqual(f.errors,[failure]);assert.equal(f.controller.lifecycle.actions,0);assert.equal(f.controller.opened,change!=='disposed');
   if(change==='disposed')assert.equal(f.controller.lifecycle.models,0);
  }finally{gate.resolve();await disposal;}
 }
});

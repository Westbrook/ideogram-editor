import test from 'node:test';
import assert from 'node:assert/strict';
import {uiModule,uiModelOwnerURL,ownFixtureJSON,allocationsURL,promptMemoryURL,modelMemoryURL} from '../ui-model-module.mjs';
import {ownFixtureCommands} from '../owned-command-fixture.mjs';
import {draftStateDependencies,jsonResponse,discardOwned} from '../draft-state-module.mjs';
import {allocationDeltaSnapshot} from '../owned-preview-module.mjs';

// Actual controller, proposal adapter, draft/refusal registry and allocation
// owners. Only the host commit, native field and server authority are fixtures.
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}');
const adapter=await uiModule('src/ui/adapters.ts');
const {DocumentDeletion}=await import(await uiModule('src/ui/deletion.ts',{'lit':lit,'./adapters.js':adapter,'./model-owner.js':uiModelOwnerURL}));
const {draftURL}=await draftStateDependencies(allocationsURL,{promptURL:promptMemoryURL,memoryURL:modelMemoryURL});
const {DraftPersistence}=await import(draftURL);
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL);
const snapshot=allocationDeltaSnapshot(allocationLedger);
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(predicate){const end=Date.now()+2000;while(!predicate()){assert(Date.now()<end,'Controller did not settle');await turn();}}
function button(template,label){
 const slots=[];
 const render=value=>{
  if(value===null||value===undefined)return '';
  if(Array.isArray(value))return value.map(render).join('');
  if(value?.strings)return value.strings.reduce((out,text,i)=>out+text+(i<value.values.length?render(value.values[i]):''),'');
  return '__slot'+(slots.push(value)-1)+'__';
 };
 const text=render(template);
 for(const match of text.matchAll(/<en-button\b([^>]*)>([\s\S]*?)<\/en-button>/g)){
  const title=match[2].replace(/__slot(\d+)__/g,(_,i)=>String(slots[Number(i)])).trim();
  if(title!==label)continue;
  const callback=/@click=__slot(\d+)__/.exec(match[1]);assert(callback,'Public button callback');return slots[Number(callback[1])];
 }
 assert.fail('Missing rendered button: '+label);
}
function event(){const host={isConnected:true};return {currentTarget:host,composedPath:()=>[host],defaultPrevented:false};}
async function fixture(){
 let seq=0,pressure,releasePreview,previewGate=Promise.resolve(),deleted=false;
 const native={value:'old'},commands=[],draftPosts=[];
 const owner=new DraftPersistence('ui',async(_path,init)=>{
  const request=JSON.parse(init.body);draftPosts.push(request);
  return jsonResponse({protocolVersion:1,requestId:request.requestId,status:'accepted',uiSeq:String(++seq),reason:null});
 },()=> 'csrf');
 owner.checkpoint={sessionId:'ui',uiSeq:'0',preferences:{documentId:'doc'},drafts:[],reconciledLayerIds:[]};
 const input=text=>({id:'draft',kind:'prompt',documentId:'doc',targetLayerId:null,expectedDocumentRevision:'1',composing:false,text});
 const releaseEditor=owner.registerDraft('draft','doc');
 const plan={id:'plan',documentId:'doc',documentRevision:'1',rootGeneration:'root',planHash:'hash',histories:1,checkpoints:0,drafts:1,jobs:0,exclusiveBytes:'1',retainedBytes:'0',pendingBytes:'0',retainedRoots:[],unresolvedAttempts:[]};
 const receipt={documentId:'doc',status:'cleanup-pending',actualFreedBytes:'0',pendingBytes:'1',retainedBytes:'0'};
 let reads=0;
 const editor={session:{identity:()=> 'client'},view:{document:{id:'doc',revision:'1'},busy:false},draftOwner:owner,
  async command(body){commands.push(body);if(body.type==='DeleteDocument'){deleted=true;editor.view.document=null;return [{type:'DocumentDeleted',payload:{id:'doc'}}];}return [];},
  async json(){reads++;await previewGate;return deleted?{receipt,jobs:[],next:null}:{plan};},copy:async()=>{}};
 const flow=new DocumentDeletion({requestUpdate(){},updateComplete:Promise.resolve(true)},ownFixtureCommands(ownFixtureJSON(editor)));
 const click=label=>button(flow.render(),label)(event());
 const idle=()=>until(()=>!flow.busy&&flow.lifecycle.pending===0&&flow.lifecycle.reads===0);
 const save=()=>discardOwned(owner.ownedSave('draft',async value=>{assert.equal(value,native.value);return 'caption_'+seq;}));
 const close=async()=>{pressure?.release();releasePreview?.();await flow.dispose();releaseEditor();await owner.dispose();assert.equal(snapshot().activeRecords,0);assert.equal(snapshot().cpuBytes,0);};
 try{owner.change(input(native.value));await save();}catch(error){await close();throw error;}
 return {owner,flow,editor,native,commands,draftPosts,click,idle,close,plan,reads:()=>reads,
  refuse(){const prior=owner.drafts.get('draft');native.value='new unsaved input '.repeat(64);
   pressure=allocationLedger.reserve({owner:'deletion-refusal-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes-32});
   assert.throws(()=>owner.change(input(native.value)),/PROMPT_MEMORY_BUDGET/);
   assert.equal(owner.drafts.get('draft'),prior);assert.equal(prior.generation,prior.savedGeneration);assert.equal(owner.hasRefusedChanges,true);
  },
  async retry(){pressure?.release();pressure=undefined;owner.change(input(native.value));await save();assert.equal(owner.hasRefusedChanges,false);},
  holdPreview(){previewGate=new Promise(resolve=>{releasePreview=resolve;});return ()=>releasePreview();},
 };
}

test('refused native input with unchanged saved generation blocks deletion and survives an explicit save retry',async()=>{
 const f=await fixture();try{
  const preview=button(f.flow.render(),'Review document deletion');f.refuse();const unsaved=f.native.value;
  preview(event());await turn();assert.deepEqual(f.commands,[]);assert.equal(f.reads(),0);
  assert.equal(f.owner.drafts.get('draft').text,'old');assert.equal(f.native.value,unsaved);assert.equal(f.owner.hasRefusedChanges,true);
  await f.retry();assert.equal(f.owner.drafts.get('draft').text,unsaved);
  f.click('Review document deletion');await until(()=>f.flow.planReady);await f.idle();
  f.click('Confirm permanent document deletion');await f.idle();
  assert.deepEqual(f.commands.map(value=>value.type),['PreviewDocumentDeletion','DeleteDocument']);
  assert.deepEqual(f.commands[1],{type:'DeleteDocument',documentId:'doc',planId:'plan',planHash:'hash',expectedRevision:'1',rootGeneration:'root',acknowledgeRunningAndUncertain:true});
 }finally{await f.close();}
});

for(const timing of ['before-dispatch','during-settlement'])test('refusal '+timing+' fences a retained deletion confirmation',async()=>{
 const f=await fixture();try{
  f.click('Review document deletion');await until(()=>f.flow.planReady);await f.idle();
  const confirm=button(f.flow.render(),'Confirm permanent document deletion');
  if(timing==='before-dispatch')f.refuse();confirm(event());if(timing==='during-settlement')f.refuse();
  await turn();await f.idle();assert.deepEqual(f.commands.map(value=>value.type),['PreviewDocumentDeletion']);
  assert.equal(f.editor.view.document.id,'doc');assert.equal(f.owner.hasRefusedChanges,true);assert.equal(f.owner.drafts.get('draft').text,'old');
  assert.equal(f.flow.plan,null);assert.equal(f.flow.planReady,false);
  await f.retry();confirm(event());await turn();await f.idle();
  assert.deepEqual(f.commands.map(value=>value.type),['PreviewDocumentDeletion'],'Saving the refused input cannot revive a captured approval; a fresh preview is required');
 }finally{await f.close();}
});

test('refusal while deletion preview bytes are pending prevents plan publication',async()=>{
 const f=await fixture();try{
  const release=f.holdPreview();f.click('Review document deletion');await until(()=>f.reads()===1);
  f.refuse();const unsaved=f.native.value;release();await f.idle();
  assert.equal(f.flow.plan,null);assert.equal(f.flow.planReady,false);
  assert.deepEqual(f.commands.map(value=>value.type),['PreviewDocumentDeletion']);
  assert.equal(f.native.value,unsaved);assert.equal(f.owner.hasRefusedChanges,true);assert.equal(f.editor.view.document.id,'doc');
 }finally{await f.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {allocationsURL} from '../owned-preview-module.mjs';

const root=process.env.IMPORT_PANEL_SOURCE_ROOT??'.',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const {allocationLedger}=await import(allocationsURL);
const adapterURL=data((await transformWithOxc(await readFile('src/ui/adapters.ts','utf8'),'adapters.ts')).code);
const {ControlAdapter}=await import(adapterURL);
const imports={
 'lit':data('export const html=()=>null,nothing=null;'),
 '../observability/allocations.js':allocationsURL,
 '../observability/model-memory.js':data('export const modelPayloadBytes=()=>{throw Error("Unexpected model measurement");};'),
 '../observability/prompt-memory.js':data('export class PromptReaderCleanupError extends Error{}'),
 '../observability/display-preview.js':data('export const createDisplayPreviewURL=()=>{throw Error("Unexpected preview read");},readDisplaySource=createDisplayPreviewURL,withDisplaySource=createDisplayPreviewURL,revokeDisplayPreviewURL=createDisplayPreviewURL,validateDisplayImage=createDisplayPreviewURL;'),
 './display-image.js':data('export const displayImage=value=>value;'),
 './adapters.js':adapterURL,
};
// Use the real import controller for task/read/render retirement. Only unused
// rendering, transport, and native URL boundaries are substituted; each row has
// a real allocation lease. The shell class is also compiled from its source.
let importCode=(await transformWithOxc(await readFile('src/ui/image-import.ts','utf8'),'image-import.ts')).code;
for(const [name,url]of Object.entries(imports))importCode=importCode.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
const {ImageImportControls}=await import(data(importCode));
const compiled=(await transformWithOxc(await readFile(root+'/src/ui/shell.ts','utf8'),'shell.ts')).code;
const shellClass=compiled.slice(compiled.indexOf('class EditorShell'),compiled.lastIndexOf('scope.register(')).replaceAll('#importHandoff','importHandoff').replaceAll('#loadImageImport','loadImageImport').replaceAll('#dialogs','dialogs');
const shellModule=await import(data(`import {allocationLedger} from ${JSON.stringify(allocationsURL)};
class LitElement{};const scope={creationScope:{}},nothing=null;let editor,connection;
function html(strings,...values){return {strings:[...strings],values};}
export function bind(client){editor=client;connection=client.session;}
${shellClass}
export {EditorShell};`));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});return {promise,resolve,reject};};
const totals=()=>{const value=allocationLedger.snapshot();return {cpu:value.cpuBytes,handles:value.handles,records:value.activeRecords};};
async function flush(){for(let index=0;index<12;index++)await Promise.resolve();}

function fixture({panel='import'}={}){
 const before=totals(),gates=[],runs=[],calls=[],failures=[];let commit=Promise.resolve(),uiRead=Promise.resolve(),stageRead=Promise.resolve(),shows=0,updates=0;
 const gate=()=>{const value=deferred();gates.push(value);return value;};
 const editor={sessionId:'session',documentEpoch:0,session:{identity:()=> 'client'},view:{ready:true,busy:false,document:{id:'document-a',revision:'1'},error:''},
  fail(error){failures.push(error);this.view.error=error.message;},
  run(label,work){if(this.view.busy)return Promise.resolve();this.view.busy=true;this.view.error='';const pending=Promise.resolve().then(work).catch(error=>this.fail(error)).finally(()=>{this.view.busy=false;});runs.push(pending);return pending;},
  async listUI(){calls.push('listUI');await uiRead;},async listStages(){calls.push('listStages');await stageRead;},
 };
 shellModule.bind(editor);
 const shell=Object.create(shellModule.EditorShell.prototype);
 // Native modality is a boundary here; events are really dispatched through
 // EventTarget and the actual ControlAdapter's deferred/veto-aware settlement.
 const dialog=new EventTarget();Object.assign(dialog,{open:true,isConnected:true,show(){shows++;this.open=true;},focus(){}});
 Object.assign(shell,{panel,isConnected:true,connectionAdmitted:true,connectionGeneration:0,lifecycle:new AbortController(),copyPanelEpoch:0,recoveryCopyAcknowledgement:null,adapter:new ControlAdapter(),panels:async()=>{},requestUpdate(){updates++;},querySelector(){return dialog;},exportFlow:{begin(){calls.push('export.begin');},cancel(){}},newDocumentFlow:{begin(){calls.push('new.begin');},cancel(){}}});
 Object.defineProperty(shell,'updateComplete',{get:()=>commit});
 const imageImport=new ImageImportControls(shell,editor);shell.imageImport=imageImport;
 const lease=allocationLedger.reserve({owner:'import-panel-fixture-row',kind:'control',cpuBytes:131072,handles:2});
 const row={id:'row',name:'retained.png',file:{name:'retained.png'},state:'ready',selected:true,loaded:true,url:'',error:'',lease};
 imageImport.rows=[row];imageImport.owner={session:'session',client:'client',documentEpoch:0};
 let releases=0;const release=imageImport.releaseDocument.bind(imageImport);imageImport.releaseDocument=()=>{releases++;return release();};
 return {before,shell,editor,imageImport,row,dialog,calls,failures,gate,get releases(){return releases;},get shows(){return shows;},get updates(){return updates;},
  bindDismissal(){const template=shell.dialogs(),start=template.strings.findIndex(text=>text.includes('id="editor-dialog"')),close=template.values[start+2];assert.ok(start>=0);assert.equal(typeof close,'function');dialog.addEventListener('en-change',close);return ()=>dialog.removeEventListener('en-change',close);},
  dismiss(){const prior=dialog.open;dialog.open=false;if(!dialog.dispatchEvent(new Event('en-change',{cancelable:true})))dialog.open=prior;},
  setCommit(value){commit=value;},setUIRead(value){uiRead=value;},setStageRead(value){stageRead=value;},
  async idle(){await Promise.allSettled(runs);},
  async closeIdle(){await Promise.allSettled([imageImport.closing]);await flush();},
  async cleanup(){for(const value of gates)value.resolve();commit=Promise.resolve();uiRead=Promise.resolve();stageRead=Promise.resolve();await Promise.allSettled(runs);await Promise.allSettled([imageImport.closing]);await flush();imageImport.cleanups.clear();await imageImport.releaseDocument();assert.deepEqual(totals(),before);},
 };
}

test('Import stays reachable through actual task, read, and native-render drain before Open is published',async()=>{
 const f=fixture(),task=f.gate(),read=f.gate(),render=f.gate();f.imageImport.task=task.promise;f.imageImport.readTasks.add(read.promise);f.setCommit(render.promise);
 try{
  f.shell.showPanel('open');await flush();assert.equal(f.releases,1);assert.equal(f.shell.panel,'import');assert.deepEqual(f.calls,[]);assert.equal(f.imageImport.inspect().items,1);
  task.resolve();await flush();assert.equal(f.shell.panel,'import');assert.deepEqual(f.calls,[]);
  read.resolve();await flush();assert.equal(f.shell.panel,'import');assert.equal(f.imageImport.inspect().items,1);assert.ok(f.row.file);assert.deepEqual(f.calls,[]);
  render.resolve();await f.idle();assert.equal(f.shell.panel,'open');assert.deepEqual(f.calls,['listUI','listStages']);assert.equal(f.imageImport.inspect().items,0);assert.equal(f.row.file,undefined);assert.equal(f.shows,1);assert.deepEqual(totals(),f.before);
  // Reproduce the reported document switch, then open Import again using its
  // actual begin() owner validation. No old batch remains to orphan that entry.
  f.editor.documentEpoch++;f.editor.view.document={id:'document-b',revision:'1'};f.shell.closePanel();f.shell.showPanel('import');await f.idle();assert.equal(f.shell.panel,'import');assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

test('cleanup rejection keeps Import reachable and a later transition retries its retained cleanup',async()=>{
 const f=fixture();let fail=true,attempts=0;const cleanup={async retry(){attempts++;if(fail)throw Error('native cleanup retained');}};f.imageImport.cleanups.add(cleanup);
 try{
  f.shell.showPanel('open');await f.idle();assert.equal(f.shell.panel,'import');assert.equal(f.imageImport.cleanups.has(cleanup),true);assert.match(f.editor.view.error,/IMAGE_IMPORT_RELEASE_FAILED/);assert.deepEqual(f.calls,[]);assert.equal(f.shows,0);
  fail=false;f.shell.showPanel('open');await f.idle();assert.equal(f.shell.panel,'open');assert.equal(attempts,2);assert.equal(f.imageImport.cleanups.size,0);assert.deepEqual(f.calls,['listUI','listStages']);
 }finally{fail=false;await f.cleanup();}
});

test('failed host commit retains the old row lease and Import until a successful retry',async()=>{
 const f=fixture(),render=f.gate();f.setCommit(render.promise);
 try{
  f.shell.showPanel('export');await flush();render.reject(Error('host commit failed'));await f.idle();assert.equal(f.shell.panel,'import');assert.equal(f.imageImport.inspect().items,1);assert.ok(f.row.file);assert.equal(totals().records,f.before.records+1);assert.deepEqual(f.calls,[]);assert.match(f.editor.view.error,/host commit failed/);
  f.setCommit(Promise.resolve());f.shell.showPanel('export');await f.idle();assert.equal(f.shell.panel,'export');assert.deepEqual(f.calls,['export.begin']);assert.equal(f.imageImport.inspect().items,0);assert.deepEqual(totals(),f.before);
 }finally{await f.cleanup();}
});

test('Cancel during Import drain keeps the panel closed after cleanup completes',async()=>{
 const f=fixture(),task=f.gate();f.imageImport.task=task.promise;
 try{f.shell.showPanel('open');await flush();assert.equal(f.shell.closePanel(),undefined);assert.equal(f.shell.panel,'import');task.resolve();await f.idle();await f.closeIdle();assert.equal(f.shell.panel,null);assert.deepEqual(f.calls,[]);assert.equal(f.shows,0);assert.equal(f.imageImport.inspect().items,0);}finally{await f.cleanup();}
});

test('a newer direct file handoff supersedes the transition waiting for Open inventory',async()=>{
 const f=fixture(),inventory=f.gate();f.setUIRead(inventory.promise);let accepted=0;
 try{
  f.shell.showPanel('open');await flush();assert.deepEqual(f.calls,['listUI']);assert.equal(f.imageImport.inspect().items,0);
  await f.shell.importHandoff([{name:'new.png'}],async()=>{accepted++;});const claimedEpoch=f.shell.copyPanelEpoch;assert.equal(accepted,1);assert.equal(f.shell.panel,'import');assert.deepEqual(totals(),f.before);
  inventory.resolve();await f.idle();assert.equal(f.shell.panel,'import');assert.equal(f.shell.copyPanelEpoch,claimedEpoch);assert.deepEqual(f.calls,['listUI']);assert.equal(f.shows,1);
 }finally{await f.cleanup();}
});

test('Cancel after next-panel publication cannot be undone by its delayed show continuation',async()=>{
 const f=fixture(),render=f.gate();f.editor.listUI=async()=>{f.calls.push('listUI');f.setCommit(render.promise);};
 try{f.shell.showPanel('open');
  // Wait for actual publication after Import drain and both inventory reads;
  // the unresolved render gate still holds the subsequent native show().
  for(let turn=0;turn<128&&f.shell.panel!=='open';turn++)await Promise.resolve();
  assert.equal(f.shell.panel,'open');assert.deepEqual(f.calls,['listUI','listStages']);assert.equal(f.editor.view.busy,true);assert.equal(f.shows,0);f.shell.closePanel();render.resolve();await f.idle();assert.equal(f.shell.panel,null);assert.equal(f.shows,0);
 }finally{await f.cleanup();}
});

test('ordinary panel changes do not invoke Import cleanup or wait for its unrelated task',async()=>{
 const f=fixture({panel:null}),task=f.gate();f.imageImport.task=task.promise;
 try{f.shell.showPanel('new');await f.idle();assert.equal(f.shell.panel,'new');assert.equal(f.releases,0);assert.deepEqual(f.calls,['new.begin']);assert.equal(f.shows,1);}finally{await f.cleanup();}
});

test('opening the existing Import panel preserves its current reviewed batch',async()=>{
 const f=fixture();
 try{f.shell.showPanel('import');await f.idle();assert.equal(f.shell.panel,'import');assert.equal(f.releases,0);assert.equal(f.imageImport.inspect().items,1);assert.ok(f.row.file);assert.deepEqual(f.failures,[]);}finally{await f.cleanup();}
});

test('Cancel cleanup failure retains reachable Import, blocks document replacement, and succeeds on the exact retry',async()=>{
 const f=fixture();let fail=true,attempts=0;const cleanup={async retry(){attempts++;if(fail)throw Error('native cleanup retained');}};f.imageImport.cleanups.add(cleanup);
 try{
  assert.equal(f.shell.closePanel(),undefined);assert.equal(f.shell.panel,'import');await f.closeIdle();assert.equal(f.shell.panel,'import');assert.equal(f.dialog.open,true);assert.equal(f.shows,1);assert.equal(f.imageImport.cleanups.has(cleanup),true);assert.match(f.editor.view.error,/IMAGE_IMPORT_RELEASE_FAILED/);
  f.shell.showPanel('open');await f.idle();assert.equal(f.shell.panel,'import');assert.deepEqual(f.calls,[]);assert.equal(f.editor.view.document.id,'document-a');
  fail=false;f.shell.closePanel();await f.closeIdle();assert.equal(f.shell.panel,null);assert.equal(attempts,3);assert.equal(f.imageImport.cleanups.size,0);assert.deepEqual(totals(),f.before);
  f.shell.showPanel('open');await f.idle();assert.equal(f.shell.panel,'open');f.editor.documentEpoch++;f.editor.view.document={id:'document-b',revision:'1'};f.shell.closePanel();f.shell.showPanel('import');await f.idle();assert.equal(f.shell.panel,'import');assert.equal(f.imageImport.inspect().items,0);
 }finally{fail=false;await f.cleanup();}
});

test('settled native dismissal reopens Import after actual failed retirement and releases it on a later dismissal',async()=>{
 const f=fixture(),render=f.gate();f.setCommit(render.promise);const unbind=f.bindDismissal();
 try{
  f.dismiss();assert.equal(f.dialog.open,false);assert.equal(f.releases,0);await flush();assert.equal(f.releases,1);assert.equal(f.shell.panel,'import');assert.equal(f.imageImport.inspect().items,1);
  render.reject(Error('host commit failed'));await f.closeIdle();assert.equal(f.shell.panel,'import');assert.equal(f.dialog.open,true);assert.equal(f.shows,1);assert.equal(f.imageImport.inspect().items,1);assert.ok(f.row.file);assert.match(f.editor.view.error,/host commit failed/);
  f.setCommit(Promise.resolve());f.dismiss();await flush();await f.closeIdle();assert.equal(f.shell.panel,null);assert.equal(f.dialog.open,false);assert.equal(f.imageImport.inspect().items,0);assert.deepEqual(totals(),f.before);
 }finally{unbind();await f.cleanup();}
});

test('a vetoed native dismissal does not begin Import retirement',async()=>{
 const f=fixture(),unbind=f.bindDismissal();const veto=event=>event.preventDefault();f.dialog.addEventListener('en-change',veto);
 try{f.dismiss();await flush();assert.equal(f.releases,0);assert.equal(f.dialog.open,true);assert.equal(f.shell.panel,'import');assert.equal(f.imageImport.inspect().items,1);}finally{f.dialog.removeEventListener('en-change',veto);unbind();await f.cleanup();}
});

test('a held already-admitted native close cannot dismiss a newer handoff identity',async()=>{
 const f=fixture(),unbind=f.bindDismissal(),panels=f.gate(),settled=f.shell.adapter.settled,readPanels=f.shell.panels;let claimed=0,accepted,handoff;
 f.shell.panels=()=>panels.promise;
 // The real adapter owns dispatch/veto/read admission. Hold only its accepted
 // callback and false value to test the captured panel epoch, not microtask count.
 f.shell.adapter.settled=function(event,read,accept){return settled.call(this,event,read,value=>{accepted={accept,value};});};
 try{
  const oldEpoch=f.shell.copyPanelEpoch;handoff=f.shell.importHandoff([{name:'later.png'}],async()=>{claimed++;});f.dismiss();await flush();
  assert.ok(accepted);assert.equal(accepted.value,false);assert.equal(f.shell.copyPanelEpoch,oldEpoch);assert.equal(claimed,0);
  panels.resolve();await handoff;assert.notEqual(f.shell.copyPanelEpoch,oldEpoch);accepted.accept(accepted.value);accepted=undefined;
  await flush();assert.equal(claimed,1);assert.equal(f.shell.panel,'import');assert.equal(f.releases,0);assert.equal(f.imageImport.inspect().items,1);assert.equal(f.dialog.open,true);
 }finally{panels.resolve();f.shell.panels=readPanels;f.shell.adapter.settled=settled;accepted=undefined;unbind();await Promise.allSettled([handoff]);await f.cleanup();}
});

test('late failed Cancel cannot reopen or dismiss a newer panel owner',async()=>{
 const f=fixture(),cleanupGate=f.gate();f.imageImport.cleanups.add({retry:()=>cleanupGate.promise});
 try{
  f.shell.closePanel();await flush();let claimed=0;await f.shell.importHandoff([{name:'later.png'}],async()=>{claimed++;});assert.equal(claimed,1);const claimedEpoch=f.shell.copyPanelEpoch;
  // Native dismissal of that newer view is not this old cleanup's authority.
  f.dialog.open=false;cleanupGate.reject(Error('old cleanup failed'));await f.closeIdle();assert.equal(f.shell.panel,'import');assert.equal(f.shell.copyPanelEpoch,claimedEpoch);assert.equal(f.dialog.open,false);assert.equal(f.shows,1);
 }finally{f.imageImport.cleanups.clear();await f.cleanup();}
});

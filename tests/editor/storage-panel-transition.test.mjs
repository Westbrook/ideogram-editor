import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';

// Exercise the actual shell methods. Controller ownership is covered separately
// by storage-library.test; these gates test the shell's module/dialog boundaries.
const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const storageURL=data(`export class StorageLibrary {constructor(host,editor,callbacks){this.host=host;this.editor=editor;this.callbacks=callbacks;globalThis.__storagePanelFixture.construct(this);}open(){return globalThis.__storagePanelFixture.open();}releaseDocument(){return globalThis.__storagePanelFixture.release();}dispose(){return this.releaseDocument();}render(){return null;}get lifecycle(){return {models:0,reads:0,pending:0,cleanupFailures:0};}}`);
const root=process.env.STORAGE_PANEL_SOURCE_ROOT??'.';
const {ControlAdapter}=await import(data((await transformWithOxc(await readFile(root+'/src/ui/adapters.ts','utf8'),'src/ui/adapters.ts')).code));
const compiled=(await transformWithOxc(await readFile(root+'/src/ui/shell.ts','utf8'),'src/ui/shell.ts')).code;
const stateStart=compiled.indexOf('let shellConnectionGeneration'),stateEnd=compiled.indexOf('const statusName',stateStart);
assert.ok(stateStart>=0&&stateEnd>stateStart,'actual module-level shell/export lifetime state');
const moduleState=compiled.slice(stateStart,stateEnd);
assert.equal([...moduleState.matchAll(/let exportModuleLoading\s*;/g)].length,1,'retain the actual shared native module promise declaration');
let body=compiled.slice(compiled.indexOf('class EditorShell'),compiled.lastIndexOf('scope.register('));
const pattern=/import\((["'])\.\/storage-library\.js\1\)/g;
assert.equal([...body.matchAll(pattern)].length,1,'one actual lazy storage boundary');
const exportPattern=/import\((["'])\.\/export\.js\1\)/g;
assert.equal([...body.matchAll(exportPattern)].length,1,'one actual lazy export boundary');
// This prototype fixture projects only the Storage and Export entry identifiers
// so it can call their unchanged bodies without constructing unrelated owners.
// It tests source control flow and the real adapter with EventTarget; it is not
// private-brand, Lit-dispatch, native-control or startup-constructor proof.
assert.equal([...body.matchAll(/#showExport\b/g)].length,3,'one private Export definition and two lexical callbacks');
assert.equal([...body.matchAll(/this\.#showExport\(/g)].length,2,'toolbar and command-search Export callbacks remain lexical');
const privateExportStart=body.search(/^\s*#showExport\(\)\s*\{/m),privateExportEnd=body.search(/^\s*action\(/m);
assert.ok(privateExportStart>=0&&privateExportEnd>privateExportStart,'actual private Export method boundaries');
assert.equal([...body.slice(privateExportStart,privateExportEnd).matchAll(exportPattern)].length,1,'native Export import remains within the private method');
assert.equal([...body.matchAll(/#showStorage\b/g)].length,3,'one private Storage definition and two lexical callbacks');
assert.equal([...body.matchAll(/this\.#showStorage\(/g)].length,2,'toolbar and command-search Storage callbacks remain lexical');
const privateStorageStart=body.search(/^\s*#showStorage\(event\)\s*\{/m);
assert.ok(privateStorageStart>=0&&privateExportStart>privateStorageStart,'actual private Storage method boundaries');
assert.equal([...body.slice(privateStorageStart,privateExportStart).matchAll(pattern)].length,1,'native Storage import remains within the private method');
body=body.replace(pattern,()=>`import(${JSON.stringify(storageURL)})`).replaceAll('#showStorage','showStorage').replaceAll('#showExport','showExport');
const toolbarBindings=[...body.matchAll(/<en-button id="storage-library-trigger"[^]*?@click=\$\{([^]*?)\}>Storage library<\/en-button>/g)];
const commandBindings=[...body.matchAll(/run:\s*(\(\)\s*=>\s*this\.showStorage\(\))/g)];
assert.equal(toolbarBindings.length,1,'one actual Storage toolbar event callback');
assert.equal(commandBindings.length,1,'one actual Storage command callback');
const storageBindings=await import(data(`export function toolbar(){return ${toolbarBindings[0][1]};}export function command(){return ${commandBindings[0][1]};}`));
const module=await import(data(`class LitElement{};let editor;export function bind(value){editor=value;}\n${moduleState}\n${body}\nexport {EditorShell};`));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});return {promise,resolve,reject};};
const flush=async()=>{for(let n=0;n<64;n++)await Promise.resolve();};
const dispatchSettled=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(predicate){const deadline=performance.now()+2000;while(!predicate()){assert.ok(performance.now()<deadline,'Expected shell transition did not occur');await new Promise(resolve=>setImmediate(resolve));}}
function fixture({panel=null,shellModule=module}={}){
 const gates=[],runs=[],calls=[],failures=[],previous=globalThis.__storagePanelFixture;let constructed=0,shows=0,updates=0,commit=Promise.resolve(),panelGate=Promise.resolve(),read=Promise.resolve(),release=Promise.resolve();
 const gate=()=>{const g=deferred();gates.push(g);return g;};
 const editor={sessionId:'session',documentEpoch:1,session:{identity:()=> 'client'},view:{ready:true,busy:false,document:null,error:''},fail(error){failures.push(error);this.view.error=error.message;},run(_label,work){if(this.view.busy)return Promise.resolve();this.view.busy=true;const task=Promise.resolve().then(work).catch(error=>this.fail(error)).finally(()=>{this.view.busy=false;});runs.push(task);return task;},async listUI(){calls.push('ui');},async listStages(){calls.push('stages');}};
 shellModule.bind(editor);
 const shell=Object.create(shellModule.EditorShell.prototype),dialog={show(){shows++;},focus(){}};
 Object.assign(shell,{adapter:new ControlAdapter(),panel,isConnected:true,connectionAdmitted:true,connectionGeneration:0,lifecycle:new AbortController(),copyPanelEpoch:0,recoveryCopyAcknowledgement:null,panels:()=>panelGate,requestUpdate(){updates++;},querySelector(){return dialog;},setRasterizeReview(){},imageImport:{begin(){calls.push('import');},releaseDocument:async()=>{}},exportFlow:{begin(){},cancel(){}},newDocumentFlow:{begin(){},cancel(){}},storageFlow:undefined});
 Object.defineProperty(shell,'updateComplete',{get:()=>commit});
 const boundary={construct(value){constructed++;shell.storageFlow=value;},async open(){calls.push('open');await read;},async release(){calls.push('release');await release;}};globalThis.__storagePanelFixture=boundary;
 return {shell,editor,calls,failures,gate,get shows(){return shows;},get constructed(){return constructed;},get updates(){return updates;},setCommit(value){commit=value;},setPanels(value){panelGate=value;},setRead(value){read=value;},setRelease(value){release=value;},async idle(){await Promise.allSettled(runs);},async cleanup(){shell.adapter.invalidate();await dispatchSettled();for(const g of gates)g.resolve();commit=panelGate=read=release=Promise.resolve();await Promise.allSettled(runs);await flush();if(previous===undefined)delete globalThis.__storagePanelFixture;else globalThis.__storagePanelFixture=previous;}};
}

test('storage opens without a document and paints the dialog before its owned read finishes',async()=>{
 const f=fixture(),read=f.gate();f.setRead(read.promise);
 try{f.shell.showStorage();await until(()=>f.calls.includes('open'));assert.equal(f.constructed,1);assert.equal(f.shell.panel,'storage');assert.equal(f.shows,1);assert.equal(f.editor.view.busy,true);read.resolve();await f.idle();assert.deepEqual(f.failures,[]);}finally{await f.cleanup();}
});
test('storage open waits for the actual panel render before starting its read',async()=>{
 const f=fixture(),render=f.gate();f.setCommit(render.promise);
 try{f.shell.showStorage();await until(()=>f.shell.panel==='storage');assert.equal(f.shows,0);assert.deepEqual(f.calls,[]);render.resolve();await f.idle();assert.equal(f.shows,1);assert.deepEqual(f.calls,['open']);}finally{await f.cleanup();}
});
test('cancelled lazy-panel opening does not publish storage or start its read',async()=>{
 const f=fixture(),panels=f.gate();f.setPanels(panels.promise);
 try{f.shell.showStorage();await flush();f.shell.closePanel();panels.resolve();await f.idle();assert.equal(f.shell.panel,null);assert.equal(f.constructed,0);assert.equal(f.shows,0);assert.deepEqual(f.calls,[]);}finally{await f.cleanup();}
});
test('document transition during opening fences the pending storage request',async()=>{
 const f=fixture(),panels=f.gate();f.setPanels(panels.promise);
 try{f.shell.showStorage();await flush();f.editor.documentEpoch++;panels.resolve();await f.idle();assert.equal(f.shell.panel,null);assert.equal(f.constructed,0);assert.deepEqual(f.calls,[]);}finally{await f.cleanup();}
});
test('connection replacement with the same session ID fences pending storage publication',async()=>{
 const f=fixture(),panels=f.gate();f.setPanels(panels.promise);
 try{f.shell.showStorage();await flush();f.editor.session={identity:()=> 'client'};panels.resolve();await f.idle();assert.equal(f.shell.panel,null);assert.equal(f.constructed,0);assert.deepEqual(f.calls,[]);}finally{await f.cleanup();}
});
test('principal replacement during the actual render does not expose or read storage',async()=>{
 const f=fixture(),render=f.gate();f.setCommit(render.promise);
 try{f.shell.showStorage();await until(()=>f.shell.panel==='storage');f.editor.session.identity=()=> 'other-client';render.resolve();await f.idle();assert.equal(f.shows,0);assert.deepEqual(f.calls,[]);}finally{await f.cleanup();}
});
test('closing storage retains its panel until actual controller release completes',async()=>{
 const f=fixture(),drain=f.gate();
 try{f.shell.showStorage();await f.idle();f.setRelease(drain.promise);f.shell.closePanel();await flush();assert.equal(f.shell.panel,'storage');assert.deepEqual(f.calls,['open','release']);drain.resolve();await until(()=>f.shell.panel===null);assert.deepEqual(f.failures,[]);}finally{await f.cleanup();}
});
test('failed storage release keeps recovery reachable and never claims a closed panel',async()=>{
 const f=fixture(),drain=f.gate();
 try{f.shell.showStorage();await f.idle();f.setRelease(drain.promise);f.shell.closePanel();drain.reject(Error('STORAGE_RELEASE_INCOMPLETE'));await until(()=>f.failures.length===1&&f.shows===2);assert.equal(f.shell.panel,'storage');assert.equal(f.failures[0].message,'STORAGE_RELEASE_INCOMPLETE');}finally{await f.cleanup();}
});
test('restore-copy handoff drains storage before existing portable Open inventories',async()=>{
 const f=fixture(),drain=f.gate();
 try{f.shell.showStorage();await f.idle();f.setRelease(drain.promise);f.shell.storageFlow.callbacks.onRestoreCopy();await until(()=>f.calls.includes('release'));assert.equal(f.shell.panel,'storage');assert.deepEqual(f.calls,['open','release']);drain.resolve();await f.idle();assert.equal(f.shell.panel,'open');assert.deepEqual(f.calls,['open','release','ui','stages']);assert.equal(f.shows,2);assert.deepEqual(f.failures,[]);}finally{await f.cleanup();}
});
test('explicit new-asset handoff drains storage and opens the existing import review',async()=>{
 const f=fixture();try{f.shell.showStorage();await f.idle();f.shell.storageFlow.callbacks.onImport();await f.idle();assert.equal(f.shell.panel,'import');assert.deepEqual(f.calls,['open','release','import']);assert.deepEqual(f.failures,[]);}finally{await f.cleanup();}
});

test('cold Storage without its private-entry loader returns before changing an existing panel',async()=>{
 const f=fixture({panel:'import'}),intent=new AbortController();let releases=0;
 f.shell.exportOpening=intent;f.shell.imageImport.releaseDocument=async()=>{releases++;};
 try{
  f.shell.showPanel('storage');await f.idle();
  assert.equal(f.editor.view.busy,false);assert.equal(intent.signal.aborted,false);assert.equal(releases,0);assert.equal(f.shell.panel,'import');assert.equal(f.shell.copyPanelEpoch,0);assert.equal(f.updates,0);assert.equal(f.constructed,0);assert.equal(f.shows,0);assert.deepEqual(f.calls,[]);assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

for(const outcome of ['accepted','vetoed','disconnected','invalidated','busy'])test(`Storage toolbar preserves deferred adapter admission when ${outcome}`,async()=>{
 const f=fixture(),trigger=Object.assign(new EventTarget(),{isConnected:true});
 trigger.addEventListener('click',storageBindings.toolbar.call(f.shell));
 if(outcome==='vetoed')trigger.addEventListener('click',event=>event.preventDefault());
 try{
  trigger.dispatchEvent(new Event('click',{cancelable:true}));
  if(outcome==='disconnected')trigger.isConnected=false;
  if(outcome==='invalidated')f.shell.adapter.invalidate();
  if(outcome==='busy')f.editor.view.busy=true;
  assert.equal(f.constructed,0);assert.equal(f.shell.panel,null);await flush();assert.equal(f.constructed,0);assert.deepEqual(f.calls,[]);
  // idle() only sees already-started operations; wait for the adapter task first.
  await dispatchSettled();await f.idle();
  const accepted=outcome==='accepted';assert.equal(f.constructed,accepted?1:0);assert.equal(f.shell.panel,accepted?'storage':null);assert.equal(f.shows,accepted?1:0);assert.deepEqual(f.calls,accepted?['open']:[]);assert.deepEqual(f.failures,[]);
 }finally{f.editor.view.busy=false;await f.cleanup();}
});

test('Storage loader waits for the departing Import owner to drain',async()=>{
 const f=fixture({panel:'import'}),drain=f.gate();let releases=0,loads=0;
 f.shell.imageImport.releaseDocument=async()=>{releases++;await drain.promise;};
 try{
  f.shell.showPanel('storage',async()=>{loads++;return import(storageURL);});await until(()=>releases===1);
  assert.equal(loads,0);assert.equal(f.constructed,0);assert.equal(f.shell.panel,'import');assert.deepEqual(f.calls,[]);
  drain.resolve();await f.idle();assert.equal(loads,1);assert.equal(f.constructed,1);assert.equal(f.shell.panel,'storage');assert.deepEqual(f.calls,['open']);assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

test('cancelled Storage loader completion does not construct or publish a controller',async()=>{
 const f=fixture(),load=f.gate();let loads=0;
 try{
  f.shell.showPanel('storage',async()=>{loads++;await load.promise;return import(storageURL);});await until(()=>loads===1);
  f.shell.closePanel();load.resolve();await f.idle();assert.equal(f.constructed,0);assert.equal(f.shell.panel,null);assert.equal(f.shows,0);assert.deepEqual(f.calls,[]);assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

test('Storage command reopens its retained controller without requiring a document',async()=>{
 const f=fixture(),activate=storageBindings.command.call(f.shell);
 try{
  activate();await f.idle();const controller=f.shell.storageFlow;assert.equal(f.constructed,1);
  f.shell.closePanel();await until(()=>f.shell.panel===null);activate();await f.idle();
  assert.equal(f.shell.storageFlow,controller);assert.equal(f.constructed,1);assert.equal(f.shell.panel,'storage');assert.equal(f.shows,2);assert.deepEqual(f.calls,['open','release','open']);assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

// Each Export fixture evaluates fresh actual shell module state. Replace only
// the one dynamic import specifier; its native promise, cache, race and owner
// checks remain product code. The controller and platform owners are boundaries.
let exportFixtureIdentity=0;
async function exportFixture(){
 const identity=++exportFixtureIdentity,load=deferred(),previous=globalThis.__exportPanelFixture;
 const events=[];let loads=0,controllers=0,begins=0,cancels=0,exportRelease=Promise.resolve();
 const boundary={events,async load(){loads++;await load.promise;},construct(){controllers++;},begin(){begins++;},cancel(){cancels++;},release(){events.push('export.release');return exportRelease;}};
 const exportURL=data(`const boundary=globalThis.__exportPanelFixture;await boundary.load();
 export class ExportControls {constructor(host,editor,close){this.host=host;this.editor=editor;this.close=close;boundary.construct();}begin(){boundary.begin();}cancel(){boundary.cancel();}releaseAndWait(){return boundary.release();}sync(){}render(){return null;}}
 // Isolate the native module cache between fixtures, never within one fixture.
 // ${identity}`);
 const exportBody=body.replace(exportPattern,()=>`import(${JSON.stringify(exportURL)})`);
 const shellModule=await import(data(`
 let editor,connection,boundary;const nothing=null,developmentShells=null;
 class LitElement {disconnectedCallback(){boundary.events.push('Lit.disconnect');}}
 function html(strings,...values){return {strings:[...strings],values};}
 const cancelDisplayPreviewReads=()=>boundary.events.push('display.cancel');
 const waitForDisplayPreviewReads=async()=>{boundary.events.push('display.wait');};
 const settleDestinationDownloads=async()=>{boundary.events.push('destination.settle');};
 const destinationResources=()=>({copyingFallbacks:0,spoolDatabases:0});
 const revokeDisplayPreviewURL=()=>{throw Error('Unexpected preview URL');};
 export function bind(value){editor=value;connection=value.session;}
 export function bindBoundary(value){boundary=value;}
 ${moduleState}
 ${exportBody}
 export {EditorShell};
 export const pendingExport=()=>exportModuleLoading;
 export const retirement=()=>shellRetirement?.promise;
 `));
 shellModule.bindBoundary(boundary);
 const f=fixture({shellModule}),cleanup=f.cleanup;
 globalThis.__exportPanelFixture=boundary;
 Object.assign(f.editor.view,{document:{id:'document-a',revision:'1'},selected:[]});
 Object.assign(f.editor,{dispose:async()=>{events.push('editor.dispose');},feedbackRendered(){},navigationControlsCommitted(){}});
 f.editor.session.dispose=async()=>{events.push('session.dispose');};
 const owner=()=>({sync:async()=>{},releaseDocument:async()=>{},dispose:async()=>{}});
 Object.assign(f.shell,{
  exportFlow:undefined,exportLoadFailed:false,connectionRestoring:false,canvasMountEpoch:0,renderGeneration:0,inspectorFieldsGeneration:0,
  temporaryPan:null,gesture:null,previewURL:'',destinationWrite:null,sessionBusy:true,
  adapter:{invalidate(){}},renderModelOwners:{commit(){}},requestNode:{querySelector:()=>null},
  read:{get snapshot(){return {view:f.editor.view,session:{busy:true}};}},
  ensureCanvasForConnectedRender(){},clearRenderedModels(){events.push('render.clear');},endTemporaryPan(){},setFields(){},
  drainInspector:async()=>{},restoreUI:async()=>{},syncInspector(){},paint:async()=>{},navigationViewportCurrent:()=>true,
  authoring:owner(),semantic:owner(),requestFlow:owner(),providerFlow:owner(),deletionFlow:owner(),textEditing:owner(),
  commandSearch:{close:async()=>{},dispose:async()=>{}},
 });
 Object.assign(f.shell.newDocumentFlow,{fields:()=>null,createButton:()=>null,releaseView:async()=>{},dispose:async()=>{}});
 const query=f.shell.querySelector;
 f.shell.querySelector=selector=>['#editor-dialog','#new-name'].includes(selector)?query(selector):null;
 Object.assign(f,{
  load,events,nativeLoad:()=>shellModule.pendingExport(),
  setExportRelease(value){exportRelease=value;},
  async detach(){f.shell.isConnected=false;f.shell.disconnectedCallback();await shellModule.retirement();},
  async cleanup(){
   load.resolve();exportRelease=Promise.resolve();f.shell.closePanel();
   await cleanup();await Promise.allSettled([shellModule.pendingExport(),shellModule.retirement()]);await flush();
   if(previous===undefined)delete globalThis.__exportPanelFixture;else globalThis.__exportPanelFixture=previous;
  },
 });
 Object.defineProperties(f,{loads:{get:()=>loads},controllers:{get:()=>controllers},begins:{get:()=>begins},cancels:{get:()=>cancels}});
 return f;
}
const templateText=value=>typeof value==='string'?value:Array.isArray(value)?value.map(templateText).join(''):value&&Array.isArray(value.strings)?value.strings.map((text,index)=>text+templateText(value.values[index])).join(''):'';
async function loadingExport(f){f.shell.showExport();await until(()=>f.loads===1);assert.equal(f.shell.panel,'export');assert.equal(f.controllers,0);assert.equal(f.editor.view.busy,true);}

test('Export module stays unevaluated until explicit activation and paints its loading dialog before construction',{timeout:5000},async()=>{
 const f=await exportFixture();
 try{
  assert.equal(f.nativeLoad(),undefined);assert.equal(f.loads,0);assert.equal(f.controllers,0);
  f.shell.showPanel('new');await f.idle();assert.equal(f.loads,0);assert.equal(f.controllers,0);f.shell.closePanel();
  f.shell.showPanel('export');await f.idle();assert.equal(f.shell.panel,null);assert.equal(f.loads,0);assert.equal(f.nativeLoad(),undefined);
  await loadingExport(f);assert.equal(f.shows,2);assert.match(templateText(f.shell.dialogs()),/Loading export controls…/);
  f.load.resolve();await f.idle();assert.equal(f.controllers,1);assert.equal(f.begins,1);assert.equal(f.shows,3);assert.equal(f.editor.view.busy,false);assert.deepEqual(f.failures,[]);
  const controller=f.shell.exportFlow;f.shell.closePanel();assert.equal(f.cancels,1);f.shell.showExport();await f.idle();
  assert.equal(f.shell.exportFlow,controller);assert.equal(f.loads,1);assert.equal(f.controllers,1);assert.equal(f.begins,2);
 }finally{await f.cleanup();}
});

test('Cancel before Export loading render commits never starts its native module',{timeout:5000},async()=>{
 const f=await exportFixture(),render=f.gate();f.setCommit(render.promise);
 try{
  f.shell.showExport();await until(()=>f.shell.panel==='export');assert.equal(f.loads,0);assert.equal(f.shows,0);
  f.shell.closePanel();render.resolve();await f.idle();assert.equal(f.shell.panel,null);assert.equal(f.nativeLoad(),undefined);assert.equal(f.controllers,0);assert.equal(f.editor.view.busy,false);assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

for(const outcome of ['resolve','reject'])test(`Cancel releases Export busy before native ${outcome} and preserves the successor Open panel`,{timeout:5000},async()=>{
 const f=await exportFixture();
 try{
  await loadingExport(f);const intent=f.shell.exportOpening,loading=f.nativeLoad();f.shell.closePanel();await until(()=>!f.editor.view.busy);
  assert.equal(intent.signal.aborted,true);assert.equal(f.shell.panel,null);assert.equal(f.controllers,0);
  f.shell.showPanel('open');await f.idle();const epoch=f.shell.copyPanelEpoch,shows=f.shows;assert.equal(f.shell.panel,'open');assert.deepEqual(f.calls,['ui','stages']);
  if(outcome==='resolve'){f.load.resolve();await loading;}else{const failure=Error('late native module rejection');f.load.reject(failure);await assert.rejects(loading,error=>error===failure);}
  await flush();assert.equal(f.shell.panel,'open');assert.equal(f.shell.copyPanelEpoch,epoch);assert.equal(f.shows,shows);assert.equal(f.controllers,0);assert.equal(f.begins,0);assert.equal(f.shell.exportLoadFailed,false);assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

test('reopening Export after Cancel joins the same pending native module for only the new intent',{timeout:5000},async()=>{
 const f=await exportFixture();
 try{
  await loadingExport(f);const previous=f.shell.exportOpening,loading=f.nativeLoad();f.shell.closePanel();await until(()=>!f.editor.view.busy);
  f.shell.showExport();await until(()=>f.shows===2);assert.notEqual(f.shell.exportOpening,previous);assert.equal(previous.signal.aborted,true);assert.equal(f.nativeLoad(),loading);assert.equal(f.loads,1);
  f.load.resolve();await f.idle();assert.equal(f.controllers,1);assert.equal(f.begins,1);assert.equal(f.shell.panel,'export');assert.equal(f.shows,3);assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

test('busy repeated panel intent preserves the admitted Export load and creates one controller',{timeout:5000},async()=>{
 const f=await exportFixture();
 try{
  await loadingExport(f);const intent=f.shell.exportOpening,loading=f.nativeLoad(),epoch=f.shell.copyPanelEpoch;
  f.shell.showExport();f.shell.showPanel('open');await flush();assert.equal(f.shell.exportOpening,intent);assert.equal(intent.signal.aborted,false);assert.equal(f.nativeLoad(),loading);assert.equal(f.shell.copyPanelEpoch,epoch);assert.equal(f.loads,1);assert.deepEqual(f.calls,[]);
  f.load.resolve();await f.idle();assert.equal(f.controllers,1);assert.equal(f.begins,1);assert.equal(f.shell.panel,'export');assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

const exportOwnershipChanges=[
 ['document epoch',f=>{f.editor.documentEpoch++;}],
 ['document identity',f=>{f.editor.view.document={id:'document-b',revision:'1'};}],
 ['document revision',f=>{f.editor.view.document={id:'document-a',revision:'2'};}],
 ['session ID',f=>{f.editor.sessionId='replacement-session';}],
 ['connection object with the same principal',f=>{f.editor.session={identity:()=> 'client'};}],
 ['principal',f=>{f.editor.session.identity=()=> 'replacement-client';}],
 ['lifetime object',f=>{f.shell.lifecycle=new AbortController();}],
 ['aborted lifetime',f=>{f.shell.lifecycle.abort();}],
 ['connection admission',f=>{f.shell.connectionAdmitted=false;}],
 ['ready state',f=>{f.editor.view.ready=false;}],
];
for(const [name,replace]of exportOwnershipChanges)test(`changed ${name} aborts Export waiting and retires only its loading placeholder`,{timeout:5000},async()=>{
 const f=await exportFixture();
 try{
  await loadingExport(f);const intent=f.shell.exportOpening,loading=f.nativeLoad();replace(f);f.shell.updated();await until(()=>!f.editor.view.busy);
  assert.equal(intent.signal.aborted,true);assert.equal(f.shell.panel,null);assert.equal(f.shell.exportOpening,undefined);assert.equal(f.shell.exportOpeningCurrent,undefined);assert.equal(f.controllers,0);assert.equal(f.shows,1);assert.deepEqual(f.failures,[]);
  f.load.resolve();await loading;await flush();assert.equal(f.shell.panel,null);assert.equal(f.controllers,0);assert.equal(f.begins,0);assert.equal(f.shows,1);assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

for(const outcome of ['resolve','reject'])test(`changed mount generation fences native Export ${outcome} and retires its old loading view`,{timeout:5000},async()=>{
 const f=await exportFixture();
 try{
  await loadingExport(f);f.shell.connectionGeneration++;
  if(outcome==='resolve')f.load.resolve();else f.load.reject(Error('stale mount module rejection'));
  await f.idle();assert.equal(f.shell.panel,null);assert.equal(f.controllers,0);assert.equal(f.begins,0);assert.equal(f.shows,1);assert.equal(f.shell.exportLoadFailed,false);assert.equal(f.editor.view.busy,false);assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

test('actual document release cancels Export waiting without awaiting native module completion',{timeout:5000},async()=>{
 const f=await exportFixture();
 try{
  await loadingExport(f);const intent=f.shell.exportOpening,loading=f.nativeLoad();await f.shell.releaseDocument();await until(()=>!f.editor.view.busy);
  assert.equal(intent.signal.aborted,true);assert.equal(f.shell.panel,null);assert.equal(f.controllers,0);assert.equal(f.events.includes('export.release'),false);
  f.editor.documentEpoch++;f.editor.view.document={id:'replacement-document',revision:'1'};f.load.resolve();await loading;await flush();
  assert.equal(f.controllers,0);assert.equal(f.begins,0);assert.equal(f.shell.panel,null);assert.equal(f.shows,1);assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

test('actual disconnect drains owners and cancels Export waiting before a late native module rejection',{timeout:5000},async()=>{
 const f=await exportFixture();
 try{
  await loadingExport(f);const intent=f.shell.exportOpening,loading=f.nativeLoad();await f.detach();await until(()=>!f.editor.view.busy);
  assert.equal(intent.signal.aborted,true);assert.equal(f.shell.lifecycle.signal.aborted,true);assert.equal(f.shell.panel,null);assert.ok(f.events.includes('editor.dispose'));assert.ok(f.events.includes('session.dispose'));assert.equal(f.controllers,0);
  const updates=f.updates,failure=Error('module failed after disconnect');f.load.reject(failure);await assert.rejects(loading,error=>error===failure);await flush();
  assert.equal(f.controllers,0);assert.equal(f.begins,0);assert.equal(f.shows,1);assert.equal(f.updates,updates);assert.equal(f.shell.exportLoadFailed,false);assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

test('a current Export module failure reports one reload-only error and retains native rejection until reload',{timeout:5000},async()=>{
 const f=await exportFixture(),failure=Error('controlled native module failure');
 try{
  await loadingExport(f);const loading=f.nativeLoad();f.load.reject(failure);await f.idle();
  assert.equal(f.failures.length,1);assert.equal(f.failures[0].cause,failure);assert.equal(f.failures[0].message,'Export controls could not be loaded. Close this dialog and reload the editor to retry.');
  assert.equal(f.shell.exportLoadFailed,true);assert.equal(f.shell.panel,'export');assert.equal(f.editor.view.busy,false);assert.equal(f.controllers,0);assert.equal(f.begins,0);assert.equal(f.shows,1);
  assert.match(templateText(f.shell.dialogs()),/Export controls are unavailable\. Close this dialog and reload the editor to retry\./);assert.doesNotMatch(templateText(f.shell.dialogs()),/Loading export controls…/);
  await flush();assert.equal(f.failures.length,1);f.shell.closePanel();assert.equal(f.shell.panel,null);
  f.shell.showExport();await f.idle();assert.equal(f.nativeLoad(),loading);assert.equal(f.loads,1);assert.equal(f.controllers,0);assert.equal(f.failures.length,2);assert.equal(f.failures[1].cause,failure);assert.equal(f.failures[1].message,f.failures[0].message);
 }finally{await f.cleanup();}
});

test('a loaded Export owner is awaited by actual document release and its failure remains owned',{timeout:5000},async()=>{
 const f=await exportFixture(),release=f.gate(),failure=Error('export release incomplete');
 try{
  await loadingExport(f);f.load.resolve();await f.idle();f.setExportRelease(release.promise);
  let settled=false;const retirement=f.shell.releaseDocument().finally(()=>{settled=true;});void retirement.catch(()=>{});
  await until(()=>f.events.includes('export.release'));await flush();assert.equal(settled,false);assert.equal(f.controllers,1);
  release.reject(failure);await assert.rejects(retirement,error=>error instanceof AggregateError&&error.message==='DOCUMENT_RELEASE_INCOMPLETE'&&error.errors.includes(failure));assert.equal(f.shell.exportFlow!==undefined,true);
  f.setExportRelease(Promise.resolve());await f.shell.releaseDocument();assert.equal(f.events.filter(value=>value==='export.release').length,2);assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

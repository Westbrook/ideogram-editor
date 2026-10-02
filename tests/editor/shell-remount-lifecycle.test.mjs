import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setMaxListeners} from 'node:events';
import {transformWithOxc} from 'vite';

// Source-authored lifecycle gates, not browser/physical qualification. Preserve
// the actual module barrier, shell methods and exported mount implementation.
// Only Lit, DOM, session/client and independently owned controller boundaries
// are substituted. Each fixture evaluates a fresh module-level lifetime.
const root=process.env.SHELL_REMOUNT_SOURCE_ROOT??'.';
const compiled=(await transformWithOxc(await readFile(root+'/src/ui/shell.ts','utf8'),'shell.ts')).code;
const barrierStart=compiled.indexOf('let shellConnectionGeneration'),barrierEnd=compiled.indexOf('const statusName',barrierStart);
const classStart=compiled.indexOf('class EditorShell'),classEnd=compiled.lastIndexOf('scope.register(');
const mountStart=compiled.indexOf('export async function mount'),mountEnd=compiled.indexOf('if (import.meta.hot)',mountStart);
assert.ok(barrierStart>=0&&barrierEnd>barrierStart&&classStart>barrierEnd&&classEnd>classStart&&mountStart>classEnd&&mountEnd>mountStart,'Actual shell lifecycle source boundaries remain explicit');
const actual=compiled.slice(barrierStart,barrierEnd)+compiled.slice(classStart,classEnd)+compiled.slice(mountStart,mountEnd);
const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
let fixtureIdentity=0;
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const causes=error=>error instanceof AggregateError?error.errors.flatMap(causes):[error];

async function fixture(){
 const module=await import(data(`
 let boundary,editor,connection,window,document;
 const AbortController=class extends globalThis.AbortController {constructor(){super();boundary.configureSignal(this.signal);}};
 const NewDocumentControls=class {constructor(host){return boundary.construct(host,'new-document');}};
 const CommandSearch=class {constructor(host){return boundary.construct(host,'command-search');}};
 const CompositionEditing=class {constructor(host){return boundary.construct(host,'composition');}};
 const NativeTextEditing=class {constructor(host){return boundary.construct(host,'text');}};
 const CanvasView=class {constructor(element){return boundary.constructCanvas(element);}};
 const nothing=null,developmentShells=new Set();
 const scope={creationScope:{},createElement(tag){if(tag!=='ie-shell')throw Error('Unexpected element');return boundary.newShell();}};
 class LitElement {connectedCallback(){boundary.calls.push(this.fixtureId+'.Lit.connect');}disconnectedCallback(){boundary.calls.push(this.fixtureId+'.Lit.disconnect');}}
 const matchMedia=()=>({matches:false,addEventListener(){}});
 const cancelDisplayPreviewReads=()=>boundary.release('display.cancel');
 const waitForDisplayPreviewReads=()=>boundary.release('display.wait');
 const revokeDisplayPreviewURL=()=>boundary.release('display.revoke');
 const settleDestinationDownloads=()=>boundary.release('destination.settle');
 const destinationResources=()=>boundary.destinationState;
 function renderInto(_value,root){boundary.release(root.owner+'.render.'+root.kind);}
 export function bind(value){boundary=value;editor=value.editor;connection=value.connection;window=value.window;document=value.document;}
 ${actual}
 export {EditorShell};
 export const lifetime=()=>({generation:shellConnectionGeneration,retirement:shellRetirement?.promise,retirementOwner:shellRetirement});
 // Distinct test fixture module, including its retained rejection state.
 // ${++fixtureIdentity}
 `));
 const calls=[],starts=[],failures=[],gates=[],shells=[],constructed=[],rules=new Map(),constructorRules=new Map();
 const window=new EventTarget(),document=new EventTarget();
 setMaxListeners(0,window,document);
 let nextId=0,nextRender=Promise.resolve(),nextStart,reportFailure,appendReactionErrors;
 const destinationState={copyingFallbacks:0,spoolDatabases:0};
 const release=name=>{calls.push(name);const work=rules.get(name);return work?.();};
 const gate=()=>{const value=deferred();gates.push(value);return value;};
 const editor={mountViewMetadata:()=>release('editor.mount'),dispose:()=>release('editor.dispose'),fail(error){failures.push(error);if(reportFailure)throw reportFailure;},flushDrafts:async()=>{},
  setViewportProbe(){calls.push('editor.viewport-probe');},documentResources:{register(){calls.push('editor.register-canvas');return ()=>release('editor.unregister-canvas');}},
  connect:async()=>{calls.push('editor.connect');},navigationViewportUnavailable(){calls.push('editor.viewport-unavailable');},
 };
 const connection={start(token){starts.push(token);calls.push('connection.start');return nextStart?.();},dispose:()=>release('connection.dispose'),renew:()=>release('connection.renew'),revoke:()=>release('connection.revoke')};
 const makeShell=()=>{
  const shell=Object.create(module.EditorShell.prototype),events=new EventTarget(),id='shell-'+(++nextId);
  let render=nextRender,canvasNode=null;nextRender=Promise.resolve();
  const owned=kind=>({dispose:()=>release(id+'.'+kind)});
  const rootNode=kind=>({owner:id,kind});
  Object.assign(shell,{
   fixtureId:id,isConnected:false,ownerDocument:document,canvasMountEpoch:0,renderGeneration:0,connectionGeneration:0,connectionAdmitted:false,connectionStart:undefined,connectionRestoring:false,copyPanelEpoch:0,inspectorFieldsGeneration:0,
   interactionEpoch:0,temporaryPan:null,gesture:null,narrow:false,extreme:false,composition:false,previewURL:'',destinationWrite:null,
   requestNode:rootNode('request'),inspectorNode:rootNode('inspector'),renderRoot:rootNode('main'),
   renderModelOwners:{clear:()=>release(id+'.render-models'),commit:()=>calls.push(id+'.render.commit')},adapter:{invalidate:()=>release(id+'.adapter')},
   resize:{disconnect:()=>release(id+'.resize'),observe:()=>calls.push(id+'.resize.observe')},unregisterResources:()=>release(id+'.unregister'),previewRead:{abort:()=>release(id+'.preview-abort')},
   newDocumentFlow:owned('new-document'),commandSearch:owned('command-search'),authoring:owned('authoring'),semantic:owned('composition'),
   requestFlow:{releaseDocument:()=>release(id+'.request')},providerFlow:owned('provider'),exportFlow:{releaseAndWait:()=>release(id+'.export')},
   imageImport:{releaseDocument:()=>release(id+'.image-import')},deletionFlow:owned('deletion'),storageFlow:owned('storage'),textEditing:owned('text'),
   inspectorTasks:new Set(),inspectorSizeReads:{release:()=>release(id+'.inspector-read')},
   addEventListener:(...args)=>events.addEventListener(...args),dispatchEvent:event=>events.dispatchEvent(event),
   requestUpdate(){calls.push(id+'.update');},querySelector(selector){return selector==='canvas'?canvasNode:null;},
   read:{get snapshot(){throw Error('Unexpected live-state read in gated lifecycle fixture');}},
  });
  Object.defineProperty(shell,'updateComplete',{get:()=>render});
  shell.setRender=value=>{render=value;};shell.setCanvasNode=value=>{canvasNode=value;};shells.push(shell);return shell;
 };
 const construct=(shell,kind)=>{
  calls.push(shell.fixtureId+'.construct.'+kind);constructorRules.get(kind)?.();
  const owner={fixtureOwner:kind+'-'+(constructed.length+1),dispose:()=>release(shell.fixtureId+'.replacement.'+owner.fixtureOwner)};
  constructed.push(owner);return owner;
 };
 const constructCanvas=element=>{calls.push('canvas.construct');return {element,ownership:{suspended:false},suspend:()=>release('canvas.suspend')};};
 const attach=shell=>{shell.isConnected=true;shell.connectedCallback();};
 const detach=shell=>{shell.isConnected=false;shell.disconnectedCallback();};
 document.querySelector=selector=>{assert.equal(selector,'#app');return {append(shell){if(!appendReactionErrors)return attach(shell);try{attach(shell);}catch(error){appendReactionErrors.push(error);}}};};
 module.bind({calls,editor,connection,window,document,release,newShell:makeShell,construct,constructCanvas,destinationState,configureSignal:signal=>setMaxListeners(0,signal)});
 return {
  module,calls,starts,failures,shells,window,gate,release,rules,constructed,constructorRules,destinationState,makeShell,attach,detach,
  setNextRender(value){nextRender=value;},setStart(work){nextStart=work;},setReportFailure(error){reportFailure=error;},setAppendReactionErrors(errors){appendReactionErrors=errors;},
  async mount(token){await module.mount(token);return shells.at(-1);},
  async idle(){await turn();await Promise.allSettled([module.lifetime().retirement,...shells.map(shell=>shell.connectionStart?.promise)]);await turn();},
  async cleanup(){
   reportFailure=undefined;rules.clear();constructorRules.clear();nextStart=undefined;destinationState.copyingFallbacks=destinationState.spoolDatabases=0;
   for(const value of gates)value.resolve();for(const shell of shells)shell.setRender(Promise.resolve());
   for(const shell of shells)if(shell.isConnected)detach(shell);
   await this.idle();
  },
 };
}

test('actual mount claims one initial token and waits for its real Lit commit',{timeout:5000},async()=>{
 const f=await fixture(),render=f.gate();f.setNextRender(render.promise);
 try{
  const mounted=f.mount('initial-pairing-token');await turn();assert.deepEqual(f.starts,[]);
  assert.deepEqual(f.calls.slice(0,2),['editor.mount','shell-1.Lit.connect']);
  render.resolve();const shell=await mounted;await f.idle();assert.deepEqual(f.starts,['initial-pairing-token']);
  await shell.startConnection('must-not-bootstrap-twice');assert.deepEqual(f.starts,['initial-pairing-token']);
 }finally{await f.cleanup();}
});

test('same shell cookie resume waits for independent owners and then the dependent session drain',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const shell=await f.mount('initial');await f.idle();
  const names=[shell.fixtureId+'.authoring',shell.fixtureId+'.image-import','display.wait','editor.dispose'];
  const drains=names.map(name=>{const d=f.gate();f.rules.set(name,()=>d.promise);return d;});
  const session=f.gate();f.rules.set('connection.dispose',()=>session.promise);
  shell.connectedOwner='retired-session';shell.sessionBusy=false;
  f.detach(shell);const retired=f.module.lifetime().retirement;f.attach(shell);await turn();
  assert.equal(shell.connectedOwner,null);assert.equal(shell.sessionBusy,true);
  for(const name of names)assert.ok(f.calls.includes(name),name);
  assert.equal(f.calls.includes('connection.dispose'),false);assert.deepEqual(f.starts,['initial']);
  for(const d of drains.slice(0,-1)){d.resolve();await turn();assert.equal(f.calls.includes('connection.dispose'),false);assert.deepEqual(f.starts,['initial']);}
  drains.at(-1).resolve();await turn();assert.equal(f.calls.filter(value=>value==='connection.dispose').length,1);assert.deepEqual(f.starts,['initial']);
  session.resolve();await retired;await f.idle();assert.deepEqual(f.starts,['initial',undefined]);assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

test('a replacement shell shares the previous element retirement barrier',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const old=await f.mount('initial');await f.idle();const drain=f.gate();f.rules.set(old.fixtureId+'.text',()=>drain.promise);
  f.detach(old);const mounted=f.mount();await turn();const replacement=f.shells.at(-1);
  assert.notEqual(replacement,old);assert.equal(replacement.isConnected,true);assert.deepEqual(f.starts,['initial']);
  drain.resolve();await mounted;await f.idle();assert.deepEqual(f.starts,['initial',undefined]);
 }finally{await f.cleanup();}
});

test('an explicit replacement mount claims its token before automatic cookie resume',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const old=await f.mount('first');await f.idle();f.detach(old);await f.idle();
  await f.mount('new-explicit-pairing');await f.idle();
  assert.deepEqual(f.starts,['first','new-explicit-pairing']);
 }finally{await f.cleanup();}
});

test('detach before initial commit forgets its token and immediate reattachments start only the latest generation',{timeout:5000},async()=>{
 const f=await fixture(),render=f.gate();f.setNextRender(render.promise);
 try{
  const mounted=f.mount('retired-token');const shell=f.shells[0];
  f.detach(shell);f.attach(shell);f.detach(shell);f.attach(shell);await turn();assert.deepEqual(f.starts,[]);
  render.resolve();await mounted;await f.idle();assert.deepEqual(f.starts,[undefined]);assert.deepEqual(f.failures,[]);
 }finally{await f.cleanup();}
});

test('an obsolete element queued resume cannot start after a newer shell claims the shared generation',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const old=await f.mount('first');await f.idle();const drain=f.gate();f.rules.set('editor.dispose',()=>drain.promise);
  f.detach(old);f.attach(old);f.detach(old);const mounted=f.mount();await turn();assert.deepEqual(f.starts,['first']);
  drain.resolve();await mounted;await f.idle();assert.deepEqual(f.starts,['first',undefined]);
  assert.equal(old.isConnected,false);assert.equal(f.shells.at(-1).isConnected,true);
 }finally{await f.cleanup();}
});

test('independent release failures aggregate after all attempts while retaining session authority for cleanup retry',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const shell=await f.mount('first');await f.idle();const id=shell.fixtureId,sync=Error('native render refused'),asyncError=Error('image retirement refused'),image=f.gate(),last=f.gate();
  shell.canvas={suspend:()=>f.release(id+'.canvas')};shell.fieldsOwner={value:{},release:()=>f.release(id+'.fields')};shell.rasterizeOwner={value:{},release:()=>f.release(id+'.rasterize')};
  shell.inspectorSizeAbort={abort:()=>f.release(id+'.inspector-abort')};shell.previewURL='blob:owned-fixture';shell.destinationWrite={committing:false,controller:{abort:()=>f.release(id+'.destination-abort')}};
  f.rules.set(id+'.render.inspector',()=>{throw sync;});f.rules.set(id+'.image-import',()=>image.promise);f.rules.set('editor.dispose',()=>last.promise);
  f.detach(shell);const retired=f.module.lifetime().retirement;let settled=false;void retired.then(()=>{settled=true;},()=>{settled=true;});
  for(const owner of ['render.request','render.inspector','render.main','fields','rasterize','adapter','resize','unregister','preview-abort','new-document','command-search','canvas','authoring','composition','request','provider','export','image-import','deletion','storage','destination-abort','text','inspector-abort','inspector-read'])assert.ok(f.calls.includes(id+'.'+owner),owner);
  assert.ok(f.calls.includes('display.cancel'));assert.ok(f.calls.includes('display.revoke'));assert.ok(f.calls.includes('display.wait'));assert.ok(f.calls.includes('editor.dispose'));assert.equal(f.calls.includes('connection.dispose'),false);
  assert.equal(shell.lifecycle.signal.aborted,true);assert.equal(shell.unregisterResources,undefined);
  f.attach(shell);image.reject(asyncError);await turn();assert.equal(settled,false);assert.deepEqual(f.starts,['first']);
  last.resolve();await assert.rejects(retired,error=>error.message==='SHELL_RETIREMENT_INCOMPLETE'&&causes(error).includes(sync)&&causes(error).includes(asyncError));
  await f.idle();assert.equal(settled,true);assert.deepEqual(f.starts,['first']);assert.equal(f.calls.includes('connection.dispose'),false);
  f.rules.delete(id+'.render.inspector');f.rules.delete(id+'.image-import');const session=f.gate();f.rules.set('connection.dispose',()=>session.promise);
  const resumed=shell.startConnection(undefined,true);void resumed.catch(()=>{});await turn();
  assert.equal(f.calls.filter(value=>value==='connection.dispose').length,1);assert.deepEqual(f.starts,['first']);
  session.resolve();await resumed;await f.idle();assert.deepEqual(f.starts,['first',undefined]);
  assert.equal(f.calls.filter(value=>value==='editor.dispose').length,1);assert.equal(f.calls.filter(value=>value==='connection.dispose').length,1);
 }finally{await f.cleanup();}
});

test('a failed shared retirement remains a barrier for later replacement shells',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const old=await f.mount('first');await f.idle();const refused=Error('retained owner');f.rules.set(old.fixtureId+'.provider',()=>{throw refused;});
  f.detach(old);await assert.rejects(f.module.lifetime().retirement,error=>causes(error).includes(refused));
  await f.mount();await f.idle();assert.deepEqual(f.starts,['first']);
  const current=f.shells.at(-1);f.detach(current);await assert.rejects(f.module.lifetime().retirement,error=>causes(error).includes(refused));
  await f.mount();await f.idle();assert.deepEqual(f.starts,['first']);
 }finally{await f.cleanup();}
});

test('failure publication cannot hide retirement failure or prevent independent cleanup',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const shell=await f.mount('first');await f.idle();const release=Error('release failed'),publication=Error('view is unavailable');
  f.rules.set(shell.fixtureId+'.new-document',()=>{throw release;});f.setReportFailure(publication);f.detach(shell);
  await assert.rejects(f.module.lifetime().retirement,error=>error.message==='SHELL_RETIREMENT_REPORT_FAILED'&&causes(error).includes(release)&&causes(error).includes(publication));
  assert.equal(f.calls.includes('connection.dispose'),false);assert.ok(f.calls.includes(shell.fixtureId+'.text'));
 }finally{await f.cleanup();}
});

test('a failed connection start is reported once per claimed mount and later resume uses only the cookie',{timeout:5000},async()=>{
 const f=await fixture(),failure=Error('resume unavailable');f.setStart(()=>Promise.reject(failure));
 try{
  const shell=await f.mount('first');await f.idle();assert.deepEqual(f.starts,['first']);assert.deepEqual(f.failures,[failure]);
  await assert.rejects(shell.startConnection('discarded-second-token'),error=>error===failure);assert.deepEqual(f.starts,['first']);assert.deepEqual(f.failures,[failure]);
  f.setStart(undefined);f.detach(shell);f.attach(shell);await f.idle();assert.deepEqual(f.starts,['first',undefined]);
 }finally{await f.cleanup();}
});

test('disconnected start requests do not retain credentials for a later mount',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const shell=f.makeShell();await shell.startConnection('not-owned');assert.deepEqual(f.starts,[]);
  f.attach(shell);await shell.startConnection();await f.idle();assert.deepEqual(f.starts,[undefined]);
 }finally{await f.cleanup();}
});

test('real pairing events replace only an unissued claim and connection checks keep its queued token',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const shell=await f.mount('first');await f.idle();const drain=f.gate();f.rules.set('editor.dispose',()=>drain.promise);
  f.detach(shell);f.attach(shell);await turn();const claim=shell.connectionStart;assert.ok(claim);assert.equal(claim.issued,false);
  f.window.__IE_PAIRING__='fresh-pairing';f.window.dispatchEvent(new Event('ie-pairing'));
  assert.equal(Object.hasOwn(f.window,'__IE_PAIRING__'),false);assert.equal(shell.connectionStart,claim);
  const checked=shell.startConnection(undefined,true);void checked.catch(()=>{});
  assert.equal(shell.connectionStart,claim);assert.deepEqual(f.starts,['first']);
  f.window.__IE_PAIRING__='latest-pairing';f.window.dispatchEvent(new Event('ie-pairing'));
  assert.equal(shell.connectionStart,claim);assert.equal(Object.hasOwn(f.window,'__IE_PAIRING__'),false);
  drain.resolve();await checked;await f.idle();assert.deepEqual(f.starts,['first','latest-pairing']);
  f.detach(shell);f.attach(shell);await f.idle();assert.deepEqual(f.starts,['first','latest-pairing',undefined]);
 }finally{await f.cleanup();}
});

test('pairing and Check connection during an issued request join it without a second request or token replay',{timeout:5000},async()=>{
 const f=await fixture(),issued=f.gate();f.setStart(()=>issued.promise);
 try{
  const shell=await f.mount('first');await turn();assert.deepEqual(f.starts,['first']);assert.equal(shell.connectionStart.issued,true);
  const claim=shell.connectionStart;f.window.__IE_PAIRING__='concurrent-token';f.window.dispatchEvent(new Event('ie-pairing'));
  const checked=shell.startConnection(undefined,true);void checked.catch(()=>{});
  assert.equal(Object.hasOwn(f.window,'__IE_PAIRING__'),false);assert.equal(shell.connectionStart,claim);assert.deepEqual(f.starts,['first']);
  issued.resolve();await checked;await f.idle();f.setStart(undefined);
  await shell.startConnection(undefined,true);assert.deepEqual(f.starts,['first',undefined]);
  await shell.startConnection();assert.deepEqual(f.starts,['first',undefined]);
 }finally{await f.cleanup();}
});

test('an explicit retry after a settled failure gets one fresh cookie request',{timeout:5000},async()=>{
 const f=await fixture(),failure=Error('connection refused');f.setStart(()=>Promise.reject(failure));
 try{
  const shell=await f.mount('first');await f.idle();assert.deepEqual(f.starts,['first']);assert.deepEqual(f.failures,[failure]);
  f.setStart(undefined);await shell.startConnection(undefined,true);await f.idle();assert.deepEqual(f.starts,['first',undefined]);
  await shell.startConnection('unused-default-token');assert.deepEqual(f.starts,['first',undefined]);
  f.window.__IE_PAIRING__='later-explicit-token';f.window.dispatchEvent(new Event('ie-pairing'));await f.idle();
  assert.deepEqual(f.starts,['first',undefined,'later-explicit-token']);assert.equal(Object.hasOwn(f.window,'__IE_PAIRING__'),false);
 }finally{await f.cleanup();}
});

test('native pointer failure cannot skip other owners and retry retains the exact old capture',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const shell=await f.mount('first');await f.idle();const failure=Error('native pointer capture release failed');let fail=true,oldReleases=0,freshReleases=0;
  shell.composition=true;shell.temporaryPan={};shell.gesture={id:7,temporary:true,oldX:4,oldY:9};
  shell.canvasElement={hasPointerCapture:id=>id===7,releasePointerCapture(id){assert.equal(id,7);oldReleases++;if(fail)throw failure;}};
  f.detach(shell);await assert.rejects(f.module.lifetime().retirement,error=>causes(error).includes(failure));
  assert.equal(shell.temporaryPan,null);assert.equal(shell.gesture,null);assert.deepEqual(shell.pan,{x:4,y:9});assert.equal(shell.lifecycle.signal.aborted,true);
  for(const owner of ['new-document','composition','text','image-import','storage'])assert.ok(f.calls.includes(shell.fixtureId+'.'+owner),owner);
  assert.ok(f.calls.includes('editor.dispose'));assert.equal(f.calls.includes('connection.dispose'),false);
  shell.canvasElement={hasPointerCapture:()=>true,releasePointerCapture(){freshReleases++;}};f.attach(shell);await f.idle();assert.deepEqual(f.starts,['first']);
  fail=false;await shell.startConnection(undefined,true);await f.idle();
  assert.equal(oldReleases,2);assert.equal(freshReleases,0);assert.equal(shell.composition,false);assert.deepEqual(f.starts,['first',undefined]);assert.equal(f.calls.filter(value=>value==='connection.dispose').length,1);
 }finally{await f.cleanup();}
});

test('terminal controllers, native canvas creation and updated connection work wait for confirmed retirement',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const shell=await f.mount('first');await f.idle();
  const old={newDocument:shell.newDocumentFlow,search:shell.commandSearch,semantic:shell.semantic,text:shell.textEditing,storage:shell.storageFlow,request:shell.requestFlow};
  const drain=f.gate();f.rules.set(shell.fixtureId+'.text',()=>drain.promise);f.detach(shell);
  shell.setCanvasNode({fixtureId:'native-canvas'});f.attach(shell);
  shell.firstUpdated();shell.updated();await turn();
  assert.equal(shell.connectionRestoring,true);assert.equal(f.constructed.length,0);assert.equal(f.calls.includes('canvas.construct'),false);
  assert.equal(f.calls.includes('editor.connect'),false);assert.equal(shell.newDocumentFlow,old.newDocument);assert.equal(shell.storageFlow,old.storage);
  drain.resolve();await f.idle();
  assert.equal(shell.connectionRestoring,false);assert.equal(f.constructed.length,4);assert.notEqual(shell.newDocumentFlow,old.newDocument);assert.notEqual(shell.commandSearch,old.search);
  assert.notEqual(shell.semantic,old.semantic);assert.notEqual(shell.textEditing,old.text);assert.equal(shell.storageFlow,undefined);assert.equal(shell.requestFlow,old.request);
  assert.equal(shell.retiredControllers,undefined);assert.equal(f.calls.filter(value=>value==='canvas.construct').length,1);assert.deepEqual(f.starts,['first',undefined]);
 }finally{await f.cleanup();}
});

test('an existing canvas is not remounted while its suspension and other owners are draining',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const shell=await f.mount('first');await f.idle();const suspended=f.gate(),other=f.gate();let suspends=0;
  shell.canvas={suspend(){suspends++;return suspended.promise;}};f.rules.set(shell.fixtureId+'.authoring',()=>other.promise);
  f.detach(shell);f.attach(shell);await turn();assert.equal(suspends,1);assert.deepEqual(f.starts,['first']);
  suspended.resolve();await turn();assert.equal(suspends,1);assert.deepEqual(f.starts,['first']);
  other.resolve();await f.idle();assert.equal(suspends,1);assert.deepEqual(f.starts,['first',undefined]);
 }finally{await f.cleanup();}
});

test('partial replacement construction is retained and resumed without rebuilding successful controllers',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const shell=await f.mount('first');await f.idle();const oldSearch=shell.commandSearch,oldNew=shell.newDocumentFlow,failure=Error('replacement search admission');
  f.constructorRules.set('command-search',()=>{throw failure;});f.detach(shell);f.attach(shell);await f.idle();
  const admittedNew=shell.newDocumentFlow;assert.notEqual(admittedNew,oldNew);assert.equal(shell.commandSearch,oldSearch);assert.equal(f.constructed.length,1);
  assert.equal(shell.connectionRestoring,true);assert.deepEqual(f.starts,['first']);assert.ok(f.failures.includes(failure));
  f.constructorRules.delete('command-search');await shell.startConnection(undefined,true);await f.idle();
  assert.equal(shell.newDocumentFlow,admittedNew);assert.notEqual(shell.commandSearch,oldSearch);assert.equal(f.constructed.length,4);
  assert.equal(f.calls.filter(value=>value===shell.fixtureId+'.construct.new-document').length,1);
  assert.equal(f.calls.filter(value=>value===shell.fixtureId+'.new-document').length,1);assert.equal(shell.retiredControllers,undefined);
  assert.deepEqual(f.starts,['first',undefined]);
 }finally{await f.cleanup();}
});

test('explicit retirement retry repeats only failed captured owners and never releases replacement scalars or controllers',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const shell=await f.mount('first');await f.idle();const id=shell.fixtureId,failure=Error('old owner refused');let fail=true;
  const counts={canvas:0,fields:0,raster:0,newDocument:0,freshCanvas:0,freshFields:0,freshRaster:0};
  const attempt=key=>{counts[key]++;if(fail)throw failure;};
  const oldCanvas={suspend:()=>attempt('canvas')},oldFields={value:{},release:()=>attempt('fields')},oldRaster={value:{},release:()=>attempt('raster')};
  shell.canvas=oldCanvas;shell.fieldsOwner=oldFields;shell.rasterizeOwner=oldRaster;
  shell.newDocumentFlow={dispose:()=>attempt('newDocument')};
  f.detach(shell);await assert.rejects(f.module.lifetime().retirement,error=>causes(error).includes(failure));f.attach(shell);await f.idle();
  assert.deepEqual(f.starts,['first']);assert.equal(f.constructed.length,0);
  const freshCanvas={suspend(){counts.freshCanvas++;}},freshFields={value:{},release(){counts.freshFields++;}},freshRaster={value:{},release(){counts.freshRaster++;}};
  shell.canvas=freshCanvas;shell.fieldsOwner=freshFields;shell.rasterizeOwner=freshRaster;fail=false;
  await shell.startConnection(undefined,true);await f.idle();
  assert.deepEqual(counts,{canvas:2,fields:2,raster:2,newDocument:2,freshCanvas:0,freshFields:0,freshRaster:0});
  assert.equal(shell.fieldsOwner,freshFields);assert.equal(shell.rasterizeOwner,freshRaster);
  for(const owner of ['authoring','provider','image-import','storage'])assert.equal(f.calls.filter(value=>value===id+'.'+owner).length,1,owner);
  const replacement=shell.newDocumentFlow;await shell.startConnection(undefined,true);await f.idle();
  assert.equal(shell.newDocumentFlow,replacement);assert.equal(counts.newDocument,2);assert.equal(f.calls.filter(value=>value.includes('.replacement.')).length,0);
  assert.deepEqual(f.starts,['first',undefined,undefined]);
 }finally{await f.cleanup();}
});

test('the retirement barrier is visible to a synchronous same-element reattachment inside owner cleanup',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const shell=await f.mount('first');await f.idle();const oldSignal=shell.lifecycle.signal,drain=f.gate();let reentered=false;
  f.rules.set(shell.fixtureId+'.render.request',()=>{if(!reentered){reentered=true;f.attach(shell);void shell.startConnection(undefined,true).catch(()=>{});}});
  f.rules.set('editor.dispose',()=>drain.promise);f.detach(shell);await turn();
  assert.equal(reentered,true);assert.equal(shell.isConnected,true);assert.equal(oldSignal.aborted,true);assert.equal(shell.lifecycle.signal.aborted,false);
  assert.equal(shell.connectionRestoring,true);assert.equal(f.constructed.length,0);assert.deepEqual(f.starts,['first']);
  drain.resolve();await f.idle();assert.deepEqual(f.starts,['first',undefined]);assert.equal(shell.connectionRestoring,false);
 }finally{await f.cleanup();}
});

test('a committing destination is drained without abort and outstanding destination resources block resume until retry',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const shell=await f.mount('first');await f.idle();const done=f.gate(),settled=f.gate();let aborted=0;
  shell.destinationWrite={committing:true,controller:{abort(){aborted++;}},done:done.promise,cleanupFailure:null};
  f.rules.set('destination.settle',()=>settled.promise);f.destinationState.copyingFallbacks=1;
  f.detach(shell);const retired=f.module.lifetime().retirement;f.attach(shell);await turn();assert.equal(aborted,0);assert.deepEqual(f.starts,['first']);
  assert.equal(f.calls.includes('destination.settle'),false);done.resolve();await turn();assert.equal(f.calls.includes('destination.settle'),true);assert.deepEqual(f.starts,['first']);
  settled.resolve();await assert.rejects(retired,error=>causes(error).some(value=>value.message==='DESTINATION_RELEASE_INCOMPLETE'));await f.idle();assert.deepEqual(f.starts,['first']);
  f.destinationState.copyingFallbacks=0;await shell.startConnection(undefined,true);await f.idle();
  assert.equal(aborted,0);assert.deepEqual(f.starts,['first',undefined]);assert.equal(f.calls.filter(value=>value==='destination.settle').length,2);
 }finally{await f.cleanup();}
});

test('an explicit connection request reentered from a failed owner retry joins its published claim and drain',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const shell=await f.mount('first');await f.idle();const owner=shell.fixtureId+'.image-import',failure=Error('old import owner refused'),drain=f.gate();
  let attempts=0,expectedClaim,reentrantClaim,nestedStart,nestedDrain;
  f.rules.set(owner,()=>{
   attempts++;if(attempts===1)throw failure;if(attempts>2)throw Error('duplicate retry callback');
   reentrantClaim=shell.connectionStart;assert.equal(reentrantClaim,expectedClaim);assert.equal(reentrantClaim.issued,false);assert.equal(reentrantClaim.settled,false);
   nestedStart=shell.startConnection('reentrant-pairing',true);void nestedStart.catch(()=>{});
   assert.equal(shell.connectionStart,reentrantClaim);
   const retirement=f.module.lifetime().retirementOwner;nestedDrain=retirement.retry();void nestedDrain.catch(()=>{});
   assert.equal(nestedDrain,retirement.promise);
   return drain.promise;
  });
  f.detach(shell);await assert.rejects(f.module.lifetime().retirement,error=>causes(error).includes(failure));
  f.attach(shell);await f.idle();assert.equal(attempts,1);assert.deepEqual(f.starts,['first']);
  const outer=shell.startConnection('outer-pairing',true);void outer.catch(()=>{});expectedClaim=shell.connectionStart;
  await turn();assert.equal(attempts,2);assert.equal(reentrantClaim,expectedClaim);assert.equal(shell.connectionStart,expectedClaim);
  assert.ok(nestedStart);assert.equal(nestedDrain,f.module.lifetime().retirement);assert.deepEqual(f.starts,['first']);
  drain.resolve();await Promise.all([outer,nestedStart,nestedDrain]);await f.idle();
  assert.equal(attempts,2);assert.equal(expectedClaim.issued,true);assert.equal(expectedClaim.settled,true);assert.deepEqual(f.starts,['first','reentrant-pairing']);
  await shell.startConnection();assert.deepEqual(f.starts,['first','reentrant-pairing']);
  f.rules.delete(owner);f.detach(shell);f.attach(shell);await f.idle();
  assert.equal(attempts,2);assert.deepEqual(f.starts,['first','reentrant-pairing',undefined]);
 }finally{await f.cleanup();}
});

test('a failed final session drain retries without repeating successful dependent owner cleanup',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const shell=await f.mount('first');await f.idle();const failure=Error('session disposal refused'),session=f.gate();let attempts=0;
  f.rules.set('connection.dispose',()=>{attempts++;if(attempts===1)throw failure;return session.promise;});
  f.detach(shell);await assert.rejects(f.module.lifetime().retirement,error=>error.message==='SHELL_RETIREMENT_INCOMPLETE'&&causes(error).includes(failure));
  const dependentCalls=f.calls.filter(value=>value!=='connection.dispose'&&(value.endsWith('.dispose')||value.startsWith(shell.fixtureId+'.')));
  assert.equal(attempts,1);assert.ok(dependentCalls.includes('editor.dispose'));
  for(const owner of ['new-document','composition','text','image-import','storage'])assert.ok(dependentCalls.includes(shell.fixtureId+'.'+owner),owner);
  f.attach(shell);await f.idle();assert.equal(attempts,1);assert.deepEqual(f.starts,['first']);
  const beforeRetry=f.calls.length,resumed=shell.startConnection(undefined,true);void resumed.catch(()=>{});
  await turn();assert.equal(attempts,2);assert.deepEqual(f.calls.slice(beforeRetry),['connection.dispose']);assert.deepEqual(f.starts,['first']);
  session.resolve();await resumed;await f.idle();assert.deepEqual(f.starts,['first',undefined]);
  assert.equal(f.calls.filter(value=>value==='editor.dispose').length,1);
  for(const owner of ['new-document','composition','text','image-import','storage'])assert.equal(f.calls.filter(value=>value===shell.fixtureId+'.'+owner).length,1,owner);
  await shell.startConnection(undefined,true);await f.idle();assert.equal(attempts,2);assert.deepEqual(f.starts,['first',undefined,undefined]);
 }finally{await f.cleanup();}
});

test('session actions and exclusive admission preserve the current shell across refused overlap and retired reattachment',{timeout:5000},async()=>{
 const f=await fixture();
 try{
  const disconnected=f.makeShell(),sessionCalls=()=>f.calls.filter(value=>value==='connection.renew'||value==='connection.revoke');
  assert.equal(disconnected.sessionAction('renew'),undefined);assert.equal(disconnected.sessionAction('revoke'),undefined);assert.deepEqual(sessionCalls(),[]);
  const shell=await f.mount('first');await f.idle();const drain=f.gate();f.rules.set('editor.dispose',()=>drain.promise);
  f.detach(shell);f.attach(shell);await turn();assert.equal(shell.isConnected,true);assert.equal(shell.connectionRestoring,true);
  assert.equal(shell.connectionGeneration,f.module.lifetime().generation);
  assert.equal(shell.sessionAction('renew'),undefined);assert.equal(shell.sessionAction('revoke'),undefined);assert.deepEqual(sessionCalls(),[]);
  drain.resolve();await f.idle();assert.equal(shell.connectionRestoring,false);assert.deepEqual(f.starts,['first',undefined]);
  const renewed={kind:'renewed'},revoked={kind:'revoked'};f.rules.set('connection.renew',()=>renewed);f.rules.set('connection.revoke',()=>Promise.resolve(revoked));
  assert.equal(shell.sessionAction('renew'),renewed);assert.equal(await shell.sessionAction('revoke'),revoked);assert.deepEqual(sessionCalls(),['connection.renew','connection.revoke']);
  const beforeOverlap={calls:[...f.calls],starts:[...f.starts],elements:f.shells.length,claim:shell.connectionStart,...f.module.lifetime()};
  await assert.rejects(f.mount('refused-overlap-token'),{message:'SHELL_ALREADY_CONNECTED'});
  assert.throws(()=>new f.module.EditorShell(),{message:'SHELL_ALREADY_CONNECTED'});
  assert.equal(f.shells.length,beforeOverlap.elements);assert.deepEqual(f.calls,beforeOverlap.calls);assert.deepEqual(f.starts,beforeOverlap.starts);
  assert.equal(shell.connectionStart,beforeOverlap.claim);assert.equal(shell.connectionAdmitted,true);assert.equal(shell.connectionRestoring,false);
  assert.equal(f.module.lifetime().generation,beforeOverlap.generation);assert.equal(f.module.lifetime().retirement,beforeOverlap.retirement);
  f.detach(shell);await f.idle();const current=await f.mount();await f.idle();
  const beforeReattach={calls:[...f.calls],starts:[...f.starts],claim:current.connectionStart,...f.module.lifetime()};
  assert.throws(()=>f.attach(shell),{message:'SHELL_ALREADY_CONNECTED'});assert.equal(shell.isConnected,true);assert.equal(shell.connectionAdmitted,false);assert.equal(shell.connectionRestoring,true);
  assert.notEqual(shell.connectionGeneration,f.module.lifetime().generation);assert.equal(current.connectionGeneration,f.module.lifetime().generation);
  assert.equal(shell.sessionAction('renew'),undefined);assert.equal(shell.sessionAction('revoke'),undefined);await shell.startConnection('retired-token',true);
  f.detach(shell);await turn();assert.equal(current.connectionAdmitted,true);assert.equal(current.connectionRestoring,false);assert.equal(current.lifecycle.signal.aborted,false);
  assert.equal(current.connectionStart,beforeReattach.claim);assert.equal(f.module.lifetime().generation,beforeReattach.generation);assert.equal(f.module.lifetime().retirement,beforeReattach.retirement);
  assert.deepEqual(f.calls,beforeReattach.calls);assert.deepEqual(f.starts,beforeReattach.starts);assert.deepEqual(sessionCalls(),['connection.renew','connection.revoke']);
  assert.equal(current.sessionAction('renew'),renewed);assert.equal(await current.sessionAction('revoke'),revoked);
  assert.deepEqual(sessionCalls(),['connection.renew','connection.revoke','connection.renew','connection.revoke']);
 }finally{await f.cleanup();}
});

test('mount rejects a swallowed custom-element metadata admission failure without awaiting Lit or acquiring shared authority',{timeout:5000},async()=>{
 const f=await fixture(),render=f.gate(),reactionErrors=[],failure=Error('metadata admission refused');
 f.setNextRender(render.promise);f.setAppendReactionErrors(reactionErrors);f.rules.set('editor.mount',()=>{throw failure;});
 try{
  let outcome,committed=false;void render.promise.then(()=>{committed=true;});
  const mounted=f.mount('unadmitted-token');void mounted.then(()=>{outcome={status:'fulfilled'};},error=>{outcome={status:'rejected',error};});
  await turn();assert.equal(outcome?.status,'rejected');assert.equal(outcome.error.message,'SHELL_CONNECTION_NOT_ADMITTED');assert.equal(committed,false);
  assert.deepEqual(reactionErrors,[failure]);assert.equal(f.shells.length,1);const shell=f.shells[0];
  assert.equal(shell.isConnected,true);assert.equal(shell.connectionAdmitted,false);assert.equal(shell.connectionStart,undefined);
  assert.equal(shell.connectionGeneration,0);assert.equal(f.module.lifetime().generation,0);assert.equal(f.module.lifetime().retirement,undefined);
  await shell.startConnection('late-unadmitted-token',true);assert.equal(shell.sessionAction('renew'),undefined);assert.equal(shell.sessionAction('revoke'),undefined);
  assert.deepEqual(f.starts,[]);assert.deepEqual(f.calls,['editor.mount']);
  f.detach(shell);await turn();assert.equal(f.shells[0],shell);assert.equal(shell.isConnected,false);assert.equal(f.module.lifetime().retirement,undefined);
  assert.deepEqual(f.starts,[]);assert.deepEqual(f.calls,['editor.mount']);assert.equal(committed,false);
 }finally{await f.cleanup();}
});

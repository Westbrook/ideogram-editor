import {allocationsURL,ownedPreviewURL} from '../owned-preview-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';

// These tests execute the actual two controllers, ControlAdapter, draft model and
// EditingController. Only DOM painting, the renderer, storage and sealed font I/O
// are stand-ins. Deferred I/O deliberately ignores abort to test the completion
// fence as well as cancellation. No browser, worker, provider or network is used.
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const staged=process.env.IE_TEXT_OWNERSHIP_STAGING;
const transform=async path=>(await transformWithOxc(await readFile(staged&&['src/ui/native-text.ts','src/ui/text-library.ts','src/text/contracts.ts'].includes(path)?staged+'/'+path:path,'utf8'),path)).code;
function imports(code,replacements){for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return code;}
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const fontBytes=Buffer.from('isolated exact font bytes'),licenseText='isolated font license',fontHash=hash(fontBytes),licenseHash=hash(licenseText);
const font={id:'font-version',bytes:{hash:fontHash,byteLength:String(fontBytes.length),mediaType:'application/octet-stream'},licenseRecord:{hash:licenseHash,byteLength:String(Buffer.byteLength(licenseText)),mediaType:'text/plain'},origin:'bundled',faceIndex:0,format:'static-ttf',parserProfile:'test-parser',fsType:0};
const profile={fonts:[{id:'TestRegular',file:'fonts/Test-Regular.ttf',bytes:fontBytes.length,sha256:fontHash.slice(7),licenseFile:'notices/Noto-OFL.txt',licenseHash}]};
const lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}');
const adapter=data(await transform('src/ui/adapters.ts'));
const json=data(await transform('src/protocol/json.ts'));
const phases=data(await transform('src/observability/phases.ts'));
const browserPhases=data(`import {PhaseRecorder} from ${JSON.stringify(phases)};export const browserPhases={recorder:new PhaseRecorder({lane:'native-text-test'})};`);
const {browserPhases:observedPhases}=await import(browserPhases);
const {allocationLedger}=await import(allocationsURL);
const allocations=()=>{const s=allocationLedger.snapshot();return Object.fromEntries(['cpuBytes','gpuBytes','previewCacheBytes','handles','activeRecords'].map(key=>[key,s[key]]));};
const memory=data(`export const textMemory={reserve(bytes){return globalThis.__nativeTextLifecycle.reserve(bytes);},get snapshot(){const n=globalThis.__nativeTextLifecycle.held;return {cpuBytes:n,textBytes:n};}};export function registerFontBacking(bytes){globalThis.__nativeTextLifecycle.backings.push(bytes);}`);
const actualContracts=data(await transform('src/text/contracts.ts'));
const contracts=data(`export {readTextAssetResponse,retryTextAssetCleanup,cancelTextAssetResponse,retainTextAssetCleanup} from ${JSON.stringify(actualContracts)};export const LIMITS={faceBytes:16777216,textBytes:16384};export class TextFailure extends Error {constructor(code,details=null){super(code);this.code=code;this.details=details;}}
export async function hashBytes(blob){const bytes=blob instanceof Blob?await blob.arrayBuffer():blob;return 'sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');}
export function readSealedAsset(url,size,signal){return globalThis.__nativeTextLifecycle.readSealedAsset(url,size,signal);}`);
const renderer=data(`import {textMemory} from ${JSON.stringify(memory)};export {textMemory};
export class TextRenderer {
 constructor(){this.context=globalThis.__nativeTextLifecycle;this.context.renderers.push(this);this.disposed=false;}
 get lifecycle(){return {activeWorkers:this.disposed?0:1,idleWorkers:0};}
 cancel(){this.context.events.push('renderer-cancel');}
 dispose(){this.context.events.push('renderer-dispose-attempt');if(this.context.failTermination)throw Error('TEXT_TERMINATION_FAILED');if(!this.disposed){this.disposed=true;this.context.events.push('renderer-dispose');}}
 async prepare(request){const c=this.context;c.events.push('renderer-start');c.activeRenderers++;try{const result=await c.render(request);c.events.push('renderer-settle');return result;}finally{c.activeRenderers--;}}
}
export function releasePrepared(value){globalThis.__nativeTextLifecycle.events.push('prepared-release');value.release?.();}`);
const durable=data(`export class DurableTextPreparation {
 constructor(storage){this.context=globalThis.__nativeTextLifecycle;this.context.preparations.push(this);this.storage=storage;this.disposed=false;}
 cancel(){this.context.events.push('preparation-cancel');}
 dispose(){if(!this.disposed){this.disposed=true;this.context.events.push('preparation-dispose');}}
 async prepare(request,fonts){const c=this.context;c.events.push('preparation-start');c.activePreparations++;try{return await c.prepare(request,fonts,this.storage);}finally{c.activePreparations--;c.events.push('preparation-settle');}}
}
export async function releaseTextRealm(){const c=globalThis.__nativeTextLifecycle;c.events.push('realm-release');if(c.activeRenderers||c.activePreparations||c.held)throw Error('TEXT_REALM_STILL_OWNED');}`);
let libraryCode=await transform('src/ui/text-library.ts');
libraryCode=libraryCode.replace(/import\.meta\.glob\([^;]+\)/g,match=>match.includes('fonts/*')?JSON.stringify({'../../vendor/text/fonts/Test-Regular.ttf':'/test-font.ttf'}):JSON.stringify({'../../vendor/text/notices/Noto-OFL.txt':licenseText}));
const library=data(imports(libraryCode,{'../observability/allocations.js':allocationsURL,'../text/contracts.js':contracts,'../text/memory.js':memory,'../text/profile.json':data('export default '+JSON.stringify(profile))}));
const {TextLibrary}=await import(library);
const relink=data(imports(await transform('src/ui/font-relink.ts'),{'../text/contracts.js':contracts,'../text/memory.js':memory}));
const nativeCode=imports(await transform('src/ui/native-text.ts'),{
 'lit':lit,'@en-reve/primitives/interactions/editing-controller.js':import.meta.resolve('@en-reve/primitives/interactions/editing-controller.js'),
 '@en-reve/primitives/state/draft.js':import.meta.resolve('@en-reve/primitives/state/draft.js'),
 '../text/client.js':renderer,'../text/durable.js':durable,'../text/contracts.js':contracts,
 '../protocol/text.js':data('export function textPlacement(value){if(!Number.isFinite(value.x)||!Number.isFinite(value.y))throw Error("Invalid placement");return value;}'),
 '../protocol/json.js':json,'./adapters.js':adapter,'./text-library.js':library,
 '../observability/browser.js':browserPhases,'../observability/allocations.js':allocationsURL,'../observability/owned-preview.js':ownedPreviewURL,'./font-relink.js':relink,
});
const {NativeTextEditing}=await import(data(nativeCode));
const flush=async()=>{for(let i=0;i<32;i++)await Promise.resolve();};
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,5));await flush();};
const until=async(check,label)=>{for(let i=0;i<200;i++){if(check())return;await settle();}assert.fail('Did not reach '+label);};
const observe=promise=>promise.then(value=>({value}),error=>({error}));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function event(host={isConnected:true}){return {currentTarget:host,composedPath:()=>[host],defaultPrevented:false};}
function find(template,part){
 if(!template||typeof template!=='object')return;
 if(template.strings){const index=template.strings.findIndex(value=>value.includes(part));if(index>=0)return {strings:template.strings.slice(index),values:template.values.slice(index)};}
 for(const item of Array.isArray(template)?template:template.values??[]){const value=find(item,part);if(value)return value;}
}
function button(template,label){
 if(!template||typeof template!=='object')return;
 if(template.strings){const index=template.strings.findIndex(value=>value.includes('>'+label+'</en-button>'));if(index>0&&typeof template.values[index-1]==='function')return template.values[index-1];}
 for(const item of Array.isArray(template)?template:template.values??[]){const callback=button(item,label);if(callback)return callback;}
}
class Element extends EventTarget {
 constructor(ownerDocument){super();this.ownerDocument=ownerDocument;this.isConnected=true;this.value='';this.defaultValue='';this.textContent='';this.selectionStart=0;this.selectionEnd=0;this.selectionDirection='none';this.scrollTop=0;this.scrollLeft=0;this.parentNode={};this.style={setProperty(){}};this.listeners=[];this.attributes=new Map();}
 addEventListener(type,callback,options){this.listeners.push({type,callback,options});super.addEventListener(type,callback,options);}
 setAttribute(name,value){this.attributes.set(name,String(value));}
 getAttribute(name){return this.attributes.get(name)??null;}
 removeAttribute(name){this.attributes.delete(name);}
 focus(){this.ownerDocument.activeElement=this;}
 setSelectionRange(start,end,direction){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;}
 getContext(){return {putImageData(){}};}
}
const controllers=new Set(),libraries=new Set();
test.afterEach(async()=>{for(const controller of controllers){await controller.releaseDocument();await controller.dispose();}controllers.clear();for(const library of libraries)await library.releaseDocument();libraries.clear();const retained=globalThis.__nativeTextLifecycle?.expectedUnresolvedBytes??0;assert.equal(globalThis.__nativeTextLifecycle?.held??0,retained);assert.deepEqual(allocations(),{cpuBytes:retained,gpuBytes:0,previewCacheBytes:0,handles:0,activeRecords:0});allocationLedger.observeTextReservations(()=>0);delete globalThis.__nativeTextLifecycle;});
function fixture({native=true}={}){
 const document=new Element();document.ownerDocument=document;document.defaultView={AbortController,CustomEvent};document.createElement=()=>new Element(document);
 globalThis.document=document;globalThis.location=new URL('http://127.0.0.1:47001/');globalThis.innerWidth=1000;globalThis.innerHeight=800;
 globalThis.requestAnimationFrame=callback=>setTimeout(callback,0);globalThis.ImageData=class {constructor(pixels,width,height){Object.assign(this,{pixels,width,height});}};
 const context={events:[],backings:[],held:0,activeRenderers:0,activePreparations:0,renderers:[],preparations:[],
  reserve(bytes){this.held+=bytes;let live=true;return {bytes,release:()=>{if(live){live=false;this.held-=bytes;}}};},
  async readSealedAsset(){return new Blob([fontBytes]);},
  async render(){return {rgba:new Blob([new Uint8Array([1,2,3,255])]),rasterHash:'raster-preview',overflow:false,width:1,height:1};},
  async prepare(){return {candidate:{hash:hash('candidate'),byteLength:'9',mediaType:'application/json'},admissionId:'admission',dependencyHash:'dependency'};},
 };
 globalThis.__nativeTextLifecycle=context;allocationLedger.observeTextReservations(()=>context.held);
 const changes=[],commands=[],stages=[],clears=[],errors=[],reads=[],assets=[{id:'font-asset',font}],drafts=new Map();
 const editor={view:{ready:true,busy:false,document:{id:'document-a',revision:'1',width:32,height:32},image:{layers:[]}},sessionId:'session-a',draftOwner:{drafts},ui:{drafts:[]},
  session:{async transport(path,options){reads.push({path,options});return new Response(new Blob([fontBytes]),{headers:{'Content-Length':String(fontBytes.length)}});}},
  async json(path,options){reads.push({path,options});return {};},
  async fontAssets(){return assets;},
  async stageTextBlob(blob,media,kind){stages.push({blob,media,kind});return {hash:hash(Buffer.from(await blob.arrayBuffer())),byteLength:String(blob.size),mediaType:media};},
  async command(command){commands.push(command);return command.type==='ImportFont'?[{type:'AssetRegistered',payload:{asset:{id:'font-asset',font}}}]:[];},
  changeDraft(id,kind,value,target,composing,revision){changes.push({id,kind,value,target,composing,revision});const generation=String(Number(drafts.get(id)?.generation??'0')+1);drafts.set(id,{id,kind,value,generation,savedGeneration:generation});},
  async flushDrafts(){},async clearDraft(id){clears.push(id);drafts.delete(id);},async run(label,work){try{await work();}catch(error){errors.push(error);}},fail(error){errors.push(error);},select(){},
 };
 const host=new Element(document),canvas=new Element(document),inspector=new Element(document);canvas.width=0;canvas.height=0;host.controllers=[];host.updateComplete=Promise.resolve();host.addController=controller=>{host.controllers.push(controller);controller.hostConnected?.();};host.querySelector=selector=>selector==='#native-text-preview'?canvas:selector==='#inspector'?inspector:null;
 let controller,rendered;
 host.requestUpdate=()=>{host.updateComplete=Promise.resolve().then(()=>{if(controller)rendered=controller.render();for(const bridge of host.controllers)bridge.hostUpdated?.();});};
 if(native){controller=new NativeTextEditing(host,editor,()=>{},point=>point);controllers.add(controller);host.requestUpdate();}
 const click=label=>{const callback=button(rendered,label);assert(callback,'Rendered button '+label);callback(event());};
 const field=(part,value)=>{const view=find(rendered,part);assert(view,'Rendered field '+part);const callback=view.values.find(value=>typeof value==='function');assert(callback,'Field callback '+part);callback(event({isConnected:true,...value}));};
 return {controller,editor,host,document,context,canvas,changes,commands,stages,clears,errors,reads,drafts,assets,click,field,template:()=>rendered,
  async begin(){await controller.begin(new Element(document));await settle();assert(controller.active);},
  async input(text,composing=false){controller.control.value=text;const e=new Event('input');Object.defineProperties(e,{isComposing:{value:composing},inputType:{value:'insertText'}});controller.control.dispatchEvent(e);await settle();},
  library(){const result=new TextLibrary(editor);libraries.add(result);return result;},
 };
}
function released(controller){assert.equal(controller.active,false);assert.equal(controller.control.value,'');assert.equal(controller.composing,false);for(const name of ['pendingOperations','retainedTextUnits','retainedFiles','previewBytes','rendererWorkers','activePreparations','fontBackingBytes'])assert.equal(controller.lifecycle[name],0,name);assert.equal(controller.lifecycle.closing,false);}

test('document release clears owned text, files, preview and native composition while preserving saved drafts and reusable bindings',async()=>{
 const f=fixture();await f.begin();await f.input('Saved unapplied text');
 f.field('<en-file-upload label="Font file"',{files:[new File(['font'],'chosen.ttf')]});
 f.field('<en-file-upload label="Font license record"',{files:[new File(['license'],'LICENSE.txt')]});await settle();
 f.click('Preview text');await until(()=>f.controller.lifecycle.previewBytes===4,'text preview');assert.equal(f.controller.lifecycle.retainedFiles,2);
 const textarea=f.controller.control,bindings=textarea.listeners.length,permanent=f.document.listeners.length,commands=f.commands.length;
 await f.input('Unfinished composition',true);assert(f.controller.composing);
 const saved=structuredClone([...f.drafts]),changeCount=f.changes.length;
 // An event already scheduled by the old controls cannot repopulate their files.
 f.field('<en-file-upload label="Font file"',{files:[new File(['late'],'late.ttf')]});
 await f.controller.releaseDocument();await settle();released(f.controller);assert.equal(f.context.held,0);assert.equal(f.canvas.width,0);assert.equal(f.canvas.height,0);assert(f.context.renderers.every(value=>value.disposed));
 assert.equal(textarea.listeners.length,bindings);assert.equal(f.document.listeners.length,permanent);assert.deepEqual(f.clears,[]);assert.equal(f.commands.length,commands);
 assert.deepEqual([...f.drafts],saved);assert.equal(f.changes.length,changeCount);
 const durableBefore=structuredClone([...f.drafts]);await f.controller.releaseDocument();assert.deepEqual([...f.drafts],durableBefore);
 f.editor.view.document={...f.editor.view.document,id:'document-b'};await f.begin();assert.equal(f.controller.control,textarea);await f.input('New document text');assert.equal(JSON.parse(f.changes.at(-1).value).text,'New document text');assert.equal(f.changes.at(-1).revision,'1');assert.equal(f.drafts.size,2);
});

test('release drops an accepted preview buffer and its lease without changing the saved draft',async()=>{
 const f=fixture();await f.begin();await f.input('Retained preview');f.click('Preview text');await until(()=>f.controller.lifecycle.previewBytes===4,'retained preview');
 const saved=structuredClone([...f.drafts]);assert.equal(f.context.held,8);assert.equal(f.canvas.width,1);
 await f.controller.releaseDocument();released(f.controller);assert.equal(f.context.held,0);assert.equal(f.canvas.width,0);assert.equal(f.canvas.height,0);assert.deepEqual([...f.drafts],saved);assert.deepEqual(f.clears,[]);
});

test('release removes the old text error association before this textarea is reused',async()=>{
 const f=fixture();await f.begin();await f.input('Text with failed preview');f.context.render=async()=>{throw Error('Isolated preview failure');};f.click('Preview text');await until(()=>f.errors.length===1,'preview error');await flush();
 assert.equal(f.controller.control.getAttribute('aria-invalid'),'true');assert.equal(f.controller.control.getAttribute('aria-errormessage'),'native-text-error');assert.match(f.controller.control.getAttribute('aria-describedby'),/native-text-error/);
 const saved=structuredClone([...f.drafts]);await f.controller.releaseDocument();await flush();released(f.controller);assert.equal(f.controller.control.getAttribute('aria-invalid'),'false');assert.equal(f.controller.control.getAttribute('aria-errormessage'),null);assert.equal(f.controller.control.getAttribute('aria-describedby'),'native-text-policy');assert.deepEqual([...f.drafts],saved);
});

test('release aborts a pending bundled font read and waits for stale completion without recreating an editor',async()=>{
 const f=fixture(),pending=deferred();let signal;
 f.context.readSealedAsset=(url,size,current)=>{signal=current;return pending.promise;};
 const beginning=observe(f.controller.begin(new Element(f.document)));await flush();assert(signal instanceof AbortSignal);assert(f.controller.lifecycle.pendingOperations>0);
 let done=false;const releasing=f.controller.releaseDocument().then(()=>{done=true;});await flush();assert(signal.aborted);assert.equal(done,false);assert.equal(f.controller.lifecycle.closing,true);
 await f.controller.begin(new Element(f.document));assert.equal(f.controller.active,false);
 pending.resolve(new Blob([fontBytes]));await beginning;await releasing;released(f.controller);assert.equal(f.stages.length,0);assert.equal(f.commands.length,0);assert.equal(f.context.held,0);
 f.context.readSealedAsset=async()=>new Blob([fontBytes]);await f.begin();
});

for(const mode of ['existing layer','saved draft'])test('release aborts pending '+mode+' text content and cannot restore it after close',async()=>{
 const f=fixture(),pending=deferred(),text=new Blob(['retained full text']),ref={hash:hash('retained full text'),byteLength:String(text.size),mediaType:'text/plain'},source={text:{textUtf8:ref,fonts:[font],style:{primaryFont:fontHash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1.2,fill:[0,0,0,255],align:'start',direction:'auto'},frame:{width:8,height:8}}};let signal;
 const layer={id:'text-layer',version:'1',kind:'text',name:'Retained layer',locked:false};
 let bodyCancels=0;
 const draft={id:'saved-draft',kind:'text',status:'saved-unapplied',documentId:'document-a',generation:'1',expectedDocumentRevision:'1',targetLayerId:null};f.editor.ui.drafts=mode==='saved draft'?[draft]:[];
 f.editor.json=async()=>mode==='saved draft'?{draft,value:{kind:'text-draft-2',...source.text,placement:{x:0,y:0}}}:{source,layerVersion:'1'};
 f.editor.session.transport=(path,options)=>{signal=options?.signal;return pending.promise;};
 const starting=observe(mode==='existing layer'?f.controller.begin(new Element(f.document),layer):f.controller.sync());await flush();assert(signal instanceof AbortSignal);
 const saved=structuredClone(f.editor.ui.drafts);let done=false;const releasing=f.controller.releaseDocument().then(()=>{done=true;});await flush();assert(signal.aborted);assert.equal(done,false);
 pending.resolve(new Response(new ReadableStream({cancel(){bodyCancels++;}}),{headers:{'Content-Length':String(text.size)}}));await starting;await releasing;await settle();released(f.controller);assert.equal(bodyCancels,1);assert.deepEqual(f.editor.ui.drafts,saved);assert.deepEqual(f.clears,[]);assert.deepEqual(f.changes,[]);assert.deepEqual(f.commands,[]);
});

test('release also waits for a background font-status request and keeps native input empty while closing',async()=>{
 const f=fixture(),pending=deferred();let signal;
 f.editor.session.transport=(path,options)=>{assert.equal(options?.method,'HEAD');signal=options.signal;return pending.promise;};await f.begin();assert(signal instanceof AbortSignal);
 let done=false;const releasing=f.controller.releaseDocument().then(()=>{done=true;});await flush();assert(signal.aborted);assert.equal(done,false);
 await f.input('Input delivered while closing',true);assert.equal(f.controller.control.value,'');assert.equal(f.controller.composing,false);assert.deepEqual(f.changes,[]);
 pending.resolve({ok:false});await releasing;await settle();released(f.controller);assert.equal(f.controller.control.getAttribute('aria-errormessage'),null);assert.deepEqual(f.errors,[]);
});

test('unavailable text response cancels its body before reporting the source failure',async()=>{
 const f=fixture();let cancelled=0;f.editor.session.transport=async()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{status:404});
 await assert.rejects(f.controller.readText('/source?layer=one',{byteLength:'4',hash:hash('text'),mediaType:'text/plain'}),/Text source is unavailable/);assert.equal(cancelled,1);
});

for(const mode of ['existing layer','saved draft'])test('failed late '+mode+' body cancellation cannot be cleared by a closed-stream retry',async()=>{
 const f=fixture(),pending=deferred(),ref={hash:hash('text'),byteLength:'4',mediaType:'text/plain'},source={text:{textUtf8:ref,fonts:[font],style:{primaryFont:fontHash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1.2,fill:[0,0,0,255],align:'start',direction:'auto'},frame:{width:8,height:8}}};let failing=true,cancels=0;
 const layer={id:'layer',version:'1',kind:'text',name:'Retained',locked:false},draft={id:'draft',kind:'text',status:'saved-unapplied',documentId:'document-a',generation:'1',expectedDocumentRevision:'1',targetLayerId:null};
 f.editor.ui.drafts=mode==='saved draft'?[draft]:[];f.editor.json=async()=>mode==='saved draft'?{draft,value:{kind:'text-draft-2',...source.text,placement:{x:0,y:0}}}:{source,layerVersion:'1'};f.editor.session.transport=()=>pending.promise;
 const starting=observe(mode==='existing layer'?f.controller.begin(new Element(f.document),layer):f.controller.sync());await flush();const first=observe(f.controller.releaseDocument());
 pending.resolve(new Response(new ReadableStream({cancel(){cancels++;if(failing)throw Error('BODY_CANCEL_FAILED');}}),{headers:{'Content-Length':'4'}}));await starting;assert.match((await first).error.message,/TEXT_DOCUMENT_RELEASE_FAILED/);assert.equal(f.controller.lifecycle.closing,false);assert.equal(cancels,1);assert.equal(f.controller.active,false);
 failing=false;await assert.rejects(f.controller.releaseDocument(),/TEXT_DOCUMENT_RELEASE_FAILED/);assert.equal(cancels,1);assert.equal(f.context.held,4*6+65536);f.context.expectedUnresolvedBytes=f.context.held;assert.equal(f.changes.length,0);assert.equal(f.commands.length,0);controllers.delete(f.controller); // No native API can retry the failed underlying callback.
});

for(const mode of ['existing layer','saved draft'])for(const reason of [Error('stored network error'),undefined])test('late already-errored '+mode+' response does not poison document cleanup: '+String(reason),async()=>{
 const f=fixture(),pending=deferred(),ref={hash:hash('text'),byteLength:'4',mediaType:'text/plain'},source={text:{textUtf8:ref,fonts:[font],style:{primaryFont:fontHash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1.2,fill:[0,0,0,255],align:'start',direction:'auto'},frame:{width:8,height:8}}};
 const layer={id:'layer',version:'1',kind:'text',name:'Retained',locked:false},draft={id:'draft',kind:'text',status:'saved-unapplied',documentId:'document-a',generation:'1',expectedDocumentRevision:'1',targetLayerId:null};
 f.editor.ui.drafts=mode==='saved draft'?[draft]:[];f.editor.json=async()=>mode==='saved draft'?{draft,value:{kind:'text-draft-2',...source.text,placement:{x:0,y:0}}}:{source,layerVersion:'1'};f.editor.session.transport=()=>pending.promise;
 const starting=observe(mode==='existing layer'?f.controller.begin(new Element(f.document),layer):f.controller.sync());await flush();const closing=f.controller.releaseDocument();
 const body=new ReadableStream({start(controller){controller.error(reason);}});pending.resolve(new Response(body,{headers:{'Content-Length':'4'}}));await starting;await closing;released(f.controller);assert.equal(body.locked,false);assert.equal(f.context.held,0);assert.equal(f.commands.length,0);
});

for(const mode of ['existing layer','saved draft'])for(const fault of ['cancel','unlock'])test(mode+' close during an active text body read preserves '+fault+' cleanup failure',async()=>{
 const f=fixture(),reading=deferred(),ref={hash:hash('text'),byteLength:'4',mediaType:'text/plain'},source={text:{textUtf8:ref,fonts:[font],style:{primaryFont:fontHash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1.2,fill:[0,0,0,255],align:'start',direction:'auto'},frame:{width:8,height:8}}};let failing=true,cancels=0,unlocks=0;
 const body=new ReadableStream({cancel(){cancels++;if(fault==='cancel'&&failing)throw Error('UNDERLYING_CANCEL_FAILED');}}),getReader=body.getReader.bind(body);
 body.getReader=()=>{const reader=getReader(),read=reader.read.bind(reader),unlock=reader.releaseLock.bind(reader);reader.read=()=>{reading.resolve();return read();};reader.releaseLock=()=>{unlocks++;if(fault==='unlock'&&failing)throw Error('UNLOCK_FAILED');unlock();};return reader;};
 const layer={id:'layer',version:'1',kind:'text',name:'Retained',locked:false},draft={id:'draft',kind:'text',status:'saved-unapplied',documentId:'document-a',generation:'1',expectedDocumentRevision:'1',targetLayerId:null};
 f.editor.ui.drafts=mode==='saved draft'?[draft]:[];f.editor.json=async()=>mode==='saved draft'?{draft,value:{kind:'text-draft-2',...source.text,placement:{x:0,y:0}}}:{source,layerVersion:'1'};f.editor.session.transport=async()=>({ok:true,headers:new Headers({'Content-Length':'4'}),body});
 const starting=observe(mode==='existing layer'?f.controller.begin(new Element(f.document),layer):f.controller.sync());await reading.promise;const closing=observe(f.controller.releaseDocument());await starting;assert.match((await closing).error.message,/TEXT_DOCUMENT_RELEASE_FAILED/);assert.equal(cancels,1);assert(unlocks>=1);assert.equal(f.context.held,4*6+65536);
 failing=false;if(fault==='unlock'){await f.controller.releaseDocument();released(f.controller);assert.equal(body.locked,false);assert.equal(f.context.held,0);}else{await assert.rejects(f.controller.releaseDocument(),/TEXT_DOCUMENT_RELEASE_FAILED/);assert.equal(cancels,1);assert.equal(f.context.held,4*6+65536);f.context.expectedUnresolvedBytes=f.context.held;controllers.delete(f.controller);}
 assert.equal(f.changes.length,0);assert.equal(f.commands.length,0);
});

test('release terminates preview workers immediately but waits for their result disposal before releasing the realm',async()=>{
 const f=fixture(),pending=deferred();await f.begin();await f.input('Preview text');f.context.render=()=>pending.promise;f.click('Preview text');await until(()=>f.context.activeRenderers===1,'pending renderer');
 f.context.events.length=0;let done=false;const releasing=f.controller.releaseDocument().then(()=>{done=true;});await flush();assert(f.context.renderers.every(value=>value.disposed));assert.equal(done,false);assert(!f.context.events.includes('realm-release'));
 pending.resolve({rgba:new Blob([new Uint8Array([1,2,3,255])]),rasterHash:'raster-preview',overflow:false,width:1,height:1});await releasing;released(f.controller);assert.equal(f.context.held,0);
 assert(f.context.events.indexOf('prepared-release')>f.context.events.indexOf('renderer-settle'));assert(f.context.events.lastIndexOf('realm-release')>f.context.events.indexOf('prepared-release'));assert.equal(f.commands.filter(value=>value.type!=='ImportFont').length,0);
});

for(const cause of ['input','close'])test('pending preview pixel backing remains booked through '+cause+' until its native read settles',async()=>{
 const f=fixture(),pending=deferred(),reading=deferred();await f.begin();await f.input('Preview ownership');
 const rgba=new Blob([new Uint8Array([1,2,3,255])]);rgba.arrayBuffer=()=>{reading.resolve();return pending.promise;};
 f.context.render=async()=>({rgba,rasterHash:'preview',overflow:false,width:1,height:1});f.click('Preview text');await reading.promise;
 const held=f.context.held;assert(held>=fontBytes.length+8);let done=false,releasing;
 if(cause==='close')releasing=f.controller.releaseDocument().then(()=>{done=true;});else await f.input('Changed while pixels read');
 await flush();assert.equal(f.context.held,held,'The pending pixel read, copy allowance and exact font backing all remain reserved');assert.equal(f.controller.lifecycle.previewBytes,0);assert.equal(done,false);
 pending.resolve(new Uint8Array([1,2,3,255]).buffer);if(releasing)await releasing;else await until(()=>f.context.held===0,'stale preview completion');
 assert.equal(f.context.held,0);assert.equal(f.controller.lifecycle.previewBytes,0);assert.equal(f.commands.filter(value=>value.type!=='ImportFont').length,0);
 if(cause==='close'){released(f.controller);assert.equal(done,true);}else assert.equal(f.controller.control.value,'Changed while pixels read');
});

test('failed controller termination drains independent owners and retains the same worker for explicit release retry',async()=>{
 const f=fixture(),pending=deferred();await f.begin();await f.input('Retained pending preview');f.context.render=()=>pending.promise;f.click('Preview text');await until(()=>f.context.activeRenderers===1,'active renderer');const renderer=f.context.renderers[0];
 f.context.failTermination=true;const first=f.controller.releaseDocument();assert.equal(f.controller.releaseDocument(),first);assert.equal(f.controller.lifecycle.closing,true);await flush();assert.equal(renderer.disposed,false);
 pending.resolve({rgba:new Blob([new Uint8Array([1,2,3,255])]),rasterHash:'preview',overflow:false,width:1,height:1});await assert.rejects(first,/TEXT_DOCUMENT_RELEASE_FAILED/);
 assert.equal(f.controller.lifecycle.closing,false);assert.equal(f.controller.lifecycle.pendingOperations,0);assert.equal(f.controller.lifecycle.rendererWorkers,1);assert.equal(f.context.held,0);assert.equal(f.controller.renderer,renderer);assert.equal(f.context.events.includes('realm-release'),true);
 f.context.failTermination=false;await f.controller.releaseDocument();released(f.controller);assert.equal(renderer.disposed,true);assert.equal(f.context.renderers.length,1);assert.deepEqual(allocations(),{cpuBytes:0,gpuBytes:0,previewCacheBytes:0,handles:0,activeRecords:0});
});

test('exact font response is bounded during streaming and never calls unbounded blob()',async()=>{
 const f=fixture({native:false}),library=f.library();let blobs=0,cancelled=0;
 f.editor.session.transport=async()=>({ok:true,headers:new Headers(),body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array(fontBytes.length+1));},cancel(){cancelled++;}}),blob(){blobs++;throw Error('UNBOUNDED_BLOB');}});
 await assert.rejects(library.load([font]),/TEXT_ASSET_SIZE/);assert.equal(blobs,0);assert.equal(cancelled,1);assert.equal(f.context.held,0);assert.equal(f.context.backings.length,0);
});

test('failed font metadata lookup releases the real metadata ledger reservation',async()=>{
 const f=fixture({native:false}),library=f.library(),before=allocations();f.editor.fontAssets=async()=>{throw Error('METADATA_UNAVAILABLE');};await assert.rejects(library.load([font]),/METADATA_UNAVAILABLE/);assert.deepEqual(allocations(),before);assert.equal(f.context.held,0);
});

test('invalid font headers on an already-errored native stream reject admission without retaining a cleanup lease',async()=>{
 const f=fixture({native:false}),library=f.library(),body=new ReadableStream({start(controller){controller.error(Error('stored network failure'));}});
 f.editor.session.transport=async()=>new Response(body,{headers:{'Content-Length':'999'}});await assert.rejects(library.load([font]),/TEXT_ASSET_LOAD/);await library.releaseDocument();assert.equal(body.locked,false);assert.equal(f.context.held,0);assert.equal(f.context.backings.length,0);
});

test('a failing font cancellation still unlocks and cannot be reported as a successful document release',async()=>{
 const f=fixture({native:false}),library=f.library(),pending=deferred(),started=deferred();let unlocks=0,cleanupFails=true;
 const reader={read(){started.resolve();return pending.promise;},cancel(){pending.resolve({done:true});return Promise.reject(Error('cancel failed'));},releaseLock(){unlocks++;}};
 f.editor.session.transport=async()=>({ok:true,headers:new Headers(),body:{getReader:()=>reader,async cancel(){if(cleanupFails)throw Error('body cancel failed');}}});
 const loading=observe(library.load([font]));await started.promise;const releasing=observe(library.releaseDocument());
 assert.equal((await loading).error.code,'TEXT_ASSET_CLEANUP');assert.match((await releasing).error.message,/TEXT_LIBRARY_CLEANUP/);assert.equal(unlocks,1);assert.equal(f.context.held,fontBytes.length*5+65536);assert.equal(f.context.backings.length,0);
 cleanupFails=false;await assert.rejects(library.releaseDocument(),/TEXT_LIBRARY_CLEANUP/);assert.equal(unlocks,1);assert.equal(f.context.held,fontBytes.length*5+65536);f.context.expectedUnresolvedBytes=f.context.held;libraries.delete(library); // Underlying cancellation failure remains explicit.
});

test('release waits for active durable preparation to settle and does not publish its stale candidate',async()=>{
 const f=fixture(),pending=deferred();await f.begin();await f.input('Prepared text');f.click('Preview text');await until(()=>f.controller.lifecycle.previewBytes===4,'prepared preview');
 f.context.prepare=()=>pending.promise;f.click('Apply text');await until(()=>f.context.activePreparations===1,'pending preparation');const saved=structuredClone([...f.drafts]);f.context.events.length=0;
 let done=false;const releasing=f.controller.releaseDocument().then(()=>{done=true;});await flush();assert(f.context.preparations.every(value=>value.disposed));assert.equal(done,false);assert(!f.context.events.includes('realm-release'));
 pending.resolve({candidate:{hash:hash('candidate'),byteLength:'9',mediaType:'application/json'},admissionId:'admission',dependencyHash:'dependency'});await releasing;released(f.controller);assert.deepEqual([...f.drafts],saved);assert.deepEqual(f.clears,[]);assert.equal(f.commands.filter(value=>value.type!=='ImportFont').length,0);assert(f.context.events.lastIndexOf('realm-release')>f.context.events.indexOf('preparation-settle'));assert.equal(f.context.held,0);
});

test('an old rendered preview action scheduled before release cannot start a worker in the next document',async()=>{
 const f=fixture();await f.begin();const stale=button(f.template(),'Preview text');stale(event());await f.controller.releaseDocument();f.editor.view.document={...f.editor.view.document,id:'document-b'};await f.begin();await settle();assert.equal(f.context.renderers.length,0);assert.equal(f.controller.lifecycle.previewBytes,0);
 f.click('Preview text');await until(()=>f.controller.lifecycle.previewBytes===4,'new document preview');assert.equal(f.context.renderers.length,1);
});

test('TextLibrary releases retained exact font backings and can load them again for a later document',async()=>{
 const f=fixture({native:false}),library=f.library();const first=await library.load([font]);assert.equal(first.length,1);assert.equal(library.lifecycle.retainedFontBytes,fontBytes.length);assert.equal(f.context.held,fontBytes.length);
 await library.releaseDocument();assert.deepEqual(library.lifecycle,{pendingOperations:0,retainedFontBytes:0});assert.equal(f.context.held,0);
 const second=await library.load([font]);assert.equal(second.length,1);assert.notEqual(second[0].bytes,first[0].bytes);assert.equal(library.lifecycle.retainedFontBytes,fontBytes.length);
});

test('TextLibrary aborts pending content loading and fences a response that arrives after document release',async()=>{
 const f=fixture({native:false}),library=f.library(),pending=deferred();let signal;
 f.editor.session.transport=(path,options)=>{signal=options?.signal;return pending.promise;};const loading=observe(library.load([font]));await flush();assert(signal instanceof AbortSignal);
 let done=false;const releasing=library.releaseDocument().then(()=>{done=true;});await flush();assert(signal.aborted);assert.equal(done,false);
 pending.resolve(new Response(new Blob([fontBytes]),{headers:{'Content-Length':String(fontBytes.length)}}));const result=await loading;await releasing;assert(result.error);assert.deepEqual(library.lifecycle,{pendingOperations:0,retainedFontBytes:0});assert.equal(f.context.held,0);assert.equal(f.context.backings.length,0);assert.equal(f.commands.length,0);
});

for(const stage of [1,2])test('TextLibrary cannot publish an import when document release interrupts staging boundary '+stage,async()=>{
 const f=fixture({native:false}),library=f.library(),pending=deferred(),original=f.editor.stageTextBlob;let count=0;
 f.editor.stageTextBlob=async(...args)=>{count++;const result=await original(...args);return count===stage?pending.promise:result;};
 const importing=observe(library.import(new Blob([fontBytes]),new Blob([licenseText]),'local-file'));await until(()=>count===stage,'staging boundary '+stage);
 let done=false;const releasing=library.releaseDocument().then(()=>{done=true;});await flush();assert.equal(done,false);
 pending.resolve({hash:stage===1?fontHash:licenseHash,byteLength:String(stage===1?fontBytes.length:Buffer.byteLength(licenseText)),mediaType:stage===1?'application/octet-stream':'text/plain'});
 const result=await importing;await releasing;assert(result.error);assert.equal(count,stage);assert.deepEqual(f.commands,[]);assert.deepEqual(library.lifecycle,{pendingOperations:0,retainedFontBytes:0});assert.equal(f.context.held,0);
});

test('native text input diagnostics remain metadata-only and do not claim tentative pixels were presented',async()=>{
 const f=fixture();await f.begin();const setupCommands=structuredClone(f.commands);assert.deepEqual(setupCommands.map(command=>command.type),['ImportFont']);observedPhases.recorder.drain();
 await f.input('private native text never belongs in telemetry',true);
 const records=observedPhases.recorder.snapshot().records,editing=records.find(x=>x.phase==='text.edit');
 assert(editing);assert.equal(editing.outcome,'incomplete');assert.equal(editing.context.boundary,'render-submitted');assert.equal(editing.context.inputSource,'synthetic-event');assert.equal(editing.context.composing,true);
 assert.equal(JSON.stringify(records).includes('private native text'),false);assert.deepEqual(f.commands,setupCommands);
});

test('rejected Apply reports its attempted layout without replacing the draft or recording text',async()=>{
 const f=fixture();await f.begin();const setupCommands=structuredClone(f.commands);assert.deepEqual(setupCommands.map(command=>command.type),['ImportFont']);await f.input('retained private draft');observedPhases.recorder.drain();
 f.click('Apply text');await settle();
 const records=observedPhases.recorder.snapshot().records,layout=records.find(x=>x.phase==='text.layout');
 assert(layout);assert.equal(layout.outcome,'error');assert.equal(layout.context.documentId,'document-a');assert.equal(layout.context.revision,'1');
 assert.equal(JSON.stringify(records).includes('retained private draft'),false);assert.equal(f.controller.control.value,'retained private draft');assert.deepEqual(f.commands,setupCommands);
});

import {allocationsURL,ownedPreviewURL,promptMemoryURL,phasesURL as phases} from '../owned-preview-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// These tests execute the actual two controllers, ControlAdapter, draft model and
// EditingController. Only DOM painting, the renderer, storage and sealed font I/O
// are stand-ins. Deferred I/O deliberately ignores abort to test the completion
// fence as well as cancellation. No browser, worker, provider or network is used.
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const staged=process.env.IE_TEXT_OWNERSHIP_STAGING;
const nativeStaged=process.env.IE_NATIVE_VIEW_STAGING;
const controlsStaged=process.env.IE_NATIVE_CONTROLS_SOURCE_ROOT,apiStaged=process.env.IE_NATIVE_CONTROL_API_SOURCE_ROOT;
const transform=async path=>(await transformWithOxc(await readFile(process.env.IE_DRAFT_METADATA_SOURCE_ROOT&&['src/ui/native-text.ts','src/state/draft-persistence.ts','src/state/draft-values.ts'].includes(path)?process.env.IE_DRAFT_METADATA_SOURCE_ROOT+'/'+path:apiStaged&&['src/ui/native-text.ts','src/ui/text-library.ts','src/ui/native-control-memory.ts'].includes(path)?apiStaged+'/'+path:controlsStaged&&['src/ui/native-text.ts','src/ui/native-control-memory.ts'].includes(path)?controlsStaged+'/'+path:nativeStaged&&path==='src/ui/native-text.ts'?nativeStaged+'/'+path:staged&&['src/ui/native-text.ts','src/ui/text-library.ts','src/text/contracts.ts'].includes(path)?staged+'/'+path:path,'utf8'),path)).code;
function imports(code,replacements){for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return code;}
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const fontBytes=Buffer.from('isolated exact font bytes'),licenseText='isolated font license',fontHash=hash(fontBytes),licenseHash=hash(licenseText);
const font={id:'font-version',bytes:{hash:fontHash,byteLength:String(fontBytes.length),mediaType:'application/octet-stream'},licenseRecord:{hash:licenseHash,byteLength:String(Buffer.byteLength(licenseText)),mediaType:'text/plain'},origin:'bundled',faceIndex:0,format:'static-ttf',parserProfile:'test-parser',fsType:0};
const profile={fonts:[{id:'TestRegular',file:'fonts/Test-Regular.ttf',bytes:fontBytes.length,sha256:fontHash.slice(7),licenseFile:'notices/Noto-OFL.txt',licenseHash}]};
const lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}');
const adapter=data(await transform('src/ui/adapters.ts'));
const json=data(await transform('src/protocol/json.ts'));
const browserPhases=data(`import {PhaseRecorder} from ${JSON.stringify(phases)};export const browserPhases={recorder:new PhaseRecorder({lane:'native-text-test'})};`);
const {browserPhases:observedPhases}=await import(browserPhases);
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL);
// Shared instrumentation owners are a fixed baseline; controller owners must drain exactly.
const diagnosticBaseline=allocationLedger.snapshot();
const allocations=()=>{const s=allocationLedger.snapshot();return Object.fromEntries(['cpuBytes','gpuBytes','previewCacheBytes','handles','activeRecords'].map(key=>[key,s[key]-diagnosticBaseline[key]]));};
function phaseSnapshot(){const read=observedPhases.recorder.readSnapshot();try{return structuredClone(read.value);}finally{read.release();}} // Runner-owned assertion copy.
test.after(()=>observedPhases.recorder.dispose());
const memory=data(`export const textMemory={reserve(bytes){return globalThis.__nativeTextLifecycle.reserve(bytes);},get snapshot(){const n=globalThis.__nativeTextLifecycle.held;return {cpuBytes:n,textBytes:n};}};export function registerFontBacking(bytes){globalThis.__nativeTextLifecycle.backings.push(bytes);}`);
const actualContracts=data(await transform('src/text/contracts.ts'));
const contracts=data(`export {TextFailure,readTextAssetResponse,retryTextAssetCleanup,cancelTextAssetResponse,retainTextAssetCleanup} from ${JSON.stringify(actualContracts)};export const LIMITS={faceBytes:16777216,textBytes:16384,faces:16};
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
export async function releaseTextRealm(){const c=globalThis.__nativeTextLifecycle;c.events.push('realm-release');if(c.activeRenderers||c.activePreparations||c.held)throw Error('TEXT_REALM_STILL_OWNED');await c.releaseRealm?.();}`);
const models=data(imports(await transform('src/observability/model-memory.ts'),{'./allocations.js':allocationsURL,'./prompt-memory.js':promptMemoryURL}));
const libraryCode=await transform('src/ui/text-library.ts');
function libraryModule(fontProfile=profile,noticeRecords={'../../vendor/text/notices/Noto-OFL.txt':licenseText}){
 const code=libraryCode.replace(/import\.meta\.glob\([^;]+\)/g,match=>match.includes('fonts/*')?JSON.stringify({'../../vendor/text/fonts/Test-Regular.ttf':'/test-font.ttf'}):JSON.stringify(noticeRecords));
 return data(imports(code,{'../observability/model-memory.js':models,'../observability/allocations.js':allocationsURL,'../text/contracts.js':contracts,'../text/memory.js':memory,'../text/profile.json':data('const profile='+JSON.stringify(fontProfile)+';export default profile;export const fonts=profile.fonts;')}));
}
const library=libraryModule();
const {TextLibrary}=await import(library);
const relink=data(imports(await transform('src/ui/font-relink.ts'),{'../text/contracts.js':contracts,'../text/memory.js':memory}));
const {readOwnedJSON,cloneOwnedModel}=await import(models);
const controlMemory=data(imports(await transform('src/state/control-memory.ts'),{'../observability/allocations.js':allocationsURL}));
const nativeMemory=data(imports(await transform('src/ui/native-control-memory.ts'),{'../observability/allocations.js':allocationsURL,'../observability/model-memory.js':models}));
const draftValues=data(imports(await transform('src/state/draft-values.ts'),{'../observability/allocations.js':allocationsURL,'../observability/prompt-memory.js':promptMemoryURL,'../observability/model-memory.js':models,'./control-memory.js':controlMemory}));
const compiled=path=>pathToFileURL(resolve('dist/local/'+path)).href;
const sha=data(await transform('src/protocol/sha256.ts'));
const commandResults=data(imports(await transform('src/state/command-results.ts'),{'../observability/allocations.js':allocationsURL,'../observability/model-memory.js':models,'../observability/prompt-memory.js':promptMemoryURL,'./control-memory.js':controlMemory,'../protocol/json.js':json,'../protocol/sha256.js':sha,'../protocol/validate.js':compiled('src/protocol/validate.js')}));
const draftModule=data(imports(await transform('src/state/draft-persistence.ts'),{'../observability/allocations.js':allocationsURL,'../observability/prompt-memory.js':promptMemoryURL,'../observability/model-memory.js':models,'./control-memory.js':controlMemory,'./command-results.js':commandResults,'./draft-values.js':draftValues}));
const {DraftPersistence}=await import(draftModule);
const nativePreview=data(await transform('src/ui/native-text-preview.ts'));
const nativeCode=imports(await transform('src/ui/native-text.ts'),{
 './native-text-preview.js':nativePreview,
 './native-control-memory.js':nativeMemory,'../state/control-memory.js':controlMemory,'../observability/prompt-memory.js':promptMemoryURL,'../composition/core.js':compiled('src/composition/core.js'),'../text/returned-description.js':compiled('src/text/returned-description.js'),
 'lit':lit,'@en-reve/primitives/interactions/editing-controller.js':import.meta.resolve('@en-reve/primitives/interactions/editing-controller.js'),
 '@en-reve/primitives/state/draft.js':import.meta.resolve('@en-reve/primitives/state/draft.js'),
 '../text/client.js':renderer,'../text/durable.js':durable,'../text/contracts.js':contracts,
 '../protocol/text.js':data('export function textPlacement(value){if(!Number.isFinite(value.x)||!Number.isFinite(value.y))throw Error("Invalid placement");return value;}'),
 '../protocol/json.js':json,'./adapters.js':adapter,'./text-library.js':library,
 '../observability/model-memory.js':models,'../observability/browser.js':browserPhases,'../observability/allocations.js':allocationsURL,'../observability/owned-preview.js':ownedPreviewURL,'./font-relink.js':relink,
});
const {NativeTextEditing}=await import(data(nativeCode));
const flush=async()=>{for(let i=0;i<32;i++)await Promise.resolve();};
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,5));await flush();};
const until=async(check,label)=>{for(let i=0;i<200;i++){if(check())return;await settle();}assert.fail('Did not reach '+label);};
const observe=promise=>promise.then(value=>({value}),error=>({error}));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function event(host={isConnected:true}){return {currentTarget:host,composedPath:()=>[host],defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};}
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
test.afterEach(async()=>{for(const controller of controllers){await controller.releaseDocument();await controller.dispose();}controllers.clear();for(const library of libraries)await library.releaseDocument();libraries.clear();assert.equal(globalThis.__nativeTextLifecycle?.viewPins??0,0);const retained=globalThis.__nativeTextLifecycle?.expectedUnresolvedBytes??0;assert.equal(globalThis.__nativeTextLifecycle?.held??0,retained);assert.deepEqual(allocations(),{cpuBytes:retained,gpuBytes:0,previewCacheBytes:0,handles:0,activeRecords:0});allocationLedger.observeTextReservations(()=>0);delete globalThis.__nativeTextLifecycle;});
function fixture({native=true,actualChangeDraft=false,renderUpdate}={}){
 const document=new Element();document.ownerDocument=document;document.defaultView={AbortController,CustomEvent};document.createElement=()=>new Element(document);
 globalThis.document=document;globalThis.location=new URL('http://127.0.0.1:47001/');globalThis.innerWidth=1000;globalThis.innerHeight=800;
 globalThis.requestAnimationFrame=callback=>setTimeout(callback,0);globalThis.cancelAnimationFrame=handle=>clearTimeout(handle);globalThis.ImageData=class {constructor(pixels,width,height){Object.assign(this,{pixels,width,height});}};
 const context={viewPins:0,viewPinCalls:[],events:[],backings:[],held:0,activeRenderers:0,activePreparations:0,renderers:[],preparations:[],
  reserve(bytes){this.held+=bytes;let live=true;return {bytes,release:()=>{if(live){live=false;this.held-=bytes;}}};},
  async readSealedAsset(){return new Blob([fontBytes]);},
  async render(request){return {rgba:new Blob([new Uint8Array([1,2,3,255])]),rasterHash:hash('raster-preview'),textHash:hash(request.text),dependencyHash:hash('dependencies'),overflow:false,width:1,height:1};},
  async prepare(){return {candidate:{hash:hash('candidate'),byteLength:'9',mediaType:'application/json'},admissionId:'admission',dependencyHash:'dependency'};},
 };
 globalThis.__nativeTextLifecycle=context;allocationLedger.observeTextReservations(()=>context.held);
 const changes=[],commands=[],stages=[],clears=[],errors=[],reads=[],assets=[{id:'font-asset',font}],drafts=new Map(),refused=new Set();
 const editor={view:{ready:true,busy:false,document:{id:'document-a',revision:'1',width:32,height:32},image:{layers:[]}},sessionId:'session-a',draftOwner:{drafts,refuseChange(id){refused.add(id);},acceptRetained(id,text){if(drafts.get(id)?.text===text)refused.delete(id);},get hasRefusedChanges(){return refused.size>0;}},ui:{drafts:[]},
  session:{async transport(path,options){reads.push({path,options});return new Response(new Blob([fontBytes]),{headers:{'Content-Length':String(fontBytes.length)}});}},
  registerDraft(){return ()=>{};},
  pinViewModels(...models){for(const model of models)if(model&&model!==this.view.document&&!this.view.image.layers.includes(model))throw Error('VIEW_MODEL_UNOWNED');context.viewPinCalls.push(models);context.viewPins++;let live=true;return ()=>{if(live){live=false;context.viewPins--;}};},
  async json(path,options){reads.push({path,options});return {};},
  ownedJSON(path,owner,init,owns,maxBytes,kind){return readOwnedJSON(async()=>{const value=await this.json(path,init),raw=JSON.stringify(value);return new Response(raw,{headers:{'content-length':String(Buffer.byteLength(raw)),'content-type':'application/json'}});},path,{owner,init,owns,maxBytes,kind});},
  async fontAssets(){return assets;},
  async ownedFontAssets(...args){return cloneOwnedModel('fixture-font-assets',await this.fontAssets(...args));},
  async ownedStageTextBlob(...args){return cloneOwnedModel('fixture-staged-ref',await this.stageTextBlob(...args));},
  async withCommandEvents(body,work,...args){const result=cloneOwnedModel('fixture-command-events',await this.command(body,...args));try{return await work(result.value);}finally{result.release();}},
  async withJSON(path,name,work,init,owns,maxBytes,kind){const result=await this.ownedJSON(path,name,init,owns,maxBytes,kind);try{return await work(result.value);}finally{result.release();}},
  async stageTextBlob(blob,media,kind){stages.push({blob,media,kind});return {hash:hash(Buffer.from(await blob.arrayBuffer())),byteLength:String(blob.size),mediaType:media};},
  async command(command){commands.push(command);return command.type==='ImportFont'?[{type:'AssetRegistered',payload:{asset:{id:'font-asset',font}}}]:[];},
  changeDraft(id,kind,value,target,composing,revision){const prior=drafts.get(id);if(actualChangeDraft&&prior&&prior.text===value&&prior.composing===composing&&prior.expectedDocumentRevision===revision){refused.delete(id);return;}changes.push({id,kind,value,target,composing,revision});const generation=String(Number(prior?.generation??'0')+1);drafts.set(id,{id,kind,value,text:value,generation,savedGeneration:generation,...actualChangeDraft?{composing,expectedDocumentRevision:revision}:{}});refused.delete(id);},
  async flushDrafts(){},async clearDraft(id){clears.push(id);drafts.delete(id);},async run(label,work){try{await work();}catch(error){errors.push(error);}},fail(error){errors.push(error);},select(){},
 };
 const host=new Element(document),canvas=new Element(document),inspector=new Element(document);canvas.width=0;canvas.height=0;host.controllers=[];host.updateComplete=Promise.resolve();host.addController=controller=>{host.controllers.push(controller);controller.hostConnected?.();};host.querySelector=selector=>selector==='#native-text-preview'?canvas:selector==='#inspector'?inspector:null;
 let controller,rendered;
 host.requestUpdate=()=>{const commit=()=>{if(controller)rendered=controller.render();for(const bridge of host.controllers)bridge.hostUpdated?.();};host.updateComplete=renderUpdate?renderUpdate(commit):Promise.resolve().then(commit);};
 if(native){controller=new NativeTextEditing(host,editor,()=>{},point=>point);controllers.add(controller);host.requestUpdate();}
 const click=label=>{const callback=button(rendered,label);assert(callback,'Rendered button '+label);callback(event());};
 const field=(part,value)=>{const view=find(rendered,part);assert(view,'Rendered field '+part);const callback=view.values.find(value=>typeof value==='function');assert(callback,'Field callback '+part);const input=event({isConnected:true,...value});callback(input);return input.currentTarget;};
 return {controller,editor,host,document,context,canvas,changes,commands,stages,clears,errors,reads,drafts,assets,click,field,template:()=>rendered,
  async begin(){await controller.begin(new Element(document));await settle();assert(controller.active);},
  async input(text,composing=false){controller.control.value=text;const e=new Event('input');Object.defineProperties(e,{isComposing:{value:composing},inputType:{value:'insertText'}});controller.control.dispatchEvent(e);await settle();},
  library(){const result=new TextLibrary(editor);libraries.add(result);return result;},
 };
}
function released(controller){assert.equal(controller.active,false);assert.equal(controller.control.value,'');assert.equal(controller.composing,false);for(const name of ['pendingOperations','retainedTextUnits','retainedFiles','previewBytes','rendererWorkers','activePreparations','fontBackingBytes'])assert.equal(controller.lifecycle[name],0,name);assert.equal(controller.lifecycle.closing,false);}

test('every sealed bundled font retains its exact license bytes when the shared OFL body is reused',async()=>{
 const pinned=JSON.parse(await readFile('src/text/profile.json','utf8')),full=await readFile('vendor/text/notices/Noto-OFL.txt'),cjk=await readFile('vendor/text/notices/Noto-CJK-OFL.txt'),prefix=Buffer.from('Copyright 2018 The Noto Project Authors (github.com/googlei18n/noto-fonts)\n\n');
 assert.deepEqual(full.subarray(0,prefix.length),prefix);assert.deepEqual(full.subarray(prefix.length),cjk);assert(pinned.fonts.length>0);
 for(const entry of pinned.fonts){const bytes=entry.licenseFile==='notices/Noto-OFL.txt'?full:entry.licenseFile==='notices/Noto-CJK-OFL.txt'?full.subarray(prefix.length):undefined;assert(bytes,'Known exact license for '+entry.id);const notice=pinned.notices.find(value=>value.path==='vendor/text/'+entry.licenseFile);assert(notice,'Sealed license notice for '+entry.id);assert.equal(bytes.length,notice.bytes);assert.equal(hash(bytes),'sha256:'+notice.sha256);assert.equal(hash(bytes),entry.licenseHash);}
});

for(const fault of ['none','prefix','body'])test('bundled CJK license '+(fault==='none'?'stages the exact shared body':'rejects altered '+fault+' before staging'),async()=>{
 const f=fixture({native:false}),before=allocations(),prefix='Copyright 2018 The Noto Project Authors (github.com/googlei18n/noto-fonts)\n\n',body='\ufeffExact isolated CJK license\r\nKeep original bytes.\r\n',expected=Buffer.from(body),licenseHash=hash(expected);
 const cjkProfile={fonts:[{...profile.fonts[0],id:'TestCJK',licenseFile:'notices/Noto-CJK-OFL.txt',licenseHash}]},record=(fault==='prefix'?'X'+prefix.slice(1):prefix)+(fault==='body'?body.replace('Exact','Other'):body);
 const {TextLibrary:BundledLibrary}=await import(libraryModule(cjkProfile,{'../../vendor/text/notices/Noto-OFL.txt':record})),library=new BundledLibrary(f.editor);libraries.add(library);
 if(fault==='none'){
  const cjkFont={...font,id:'cjk-font-version',licenseRecord:{hash:licenseHash,byteLength:String(expected.length),mediaType:'text/plain'}};
  f.editor.command=async command=>{f.commands.push(command);assert.equal(command.type,'ImportFont');return [{type:'AssetRegistered',payload:{asset:{id:'cjk-font-asset',font:cjkFont}}}];};
  const imported=await library.bundled('TestCJK');try{assert.deepEqual(imported.value,cjkFont);assert.equal(f.stages.length,2);assert.deepEqual(Buffer.from(await f.stages[0].blob.arrayBuffer()),fontBytes);assert.deepEqual(Buffer.from(await f.stages[1].blob.arrayBuffer()),expected);assert.equal(f.stages[1].media,'text/plain');assert.equal(f.stages[1].kind,'caption');assert.equal(f.commands.length,1);assert.deepEqual(f.commands[0].license,{hash:licenseHash,byteLength:String(expected.length),mediaType:'text/plain'});assert.equal(f.commands[0].origin,'bundled');assert.equal(f.commands[0].embeddingReviewed,true);}finally{imported.release();}
 }else{await assert.rejects(library.bundled('TestCJK'),fault==='prefix'?/FONT_LICENSE_UNAVAILABLE/:/FONT_HASH/);assert.deepEqual(f.stages,[]);assert.deepEqual(f.commands,[]);}
 await library.releaseDocument();assert.deepEqual(library.lifecycle,{pendingOperations:0,retainedFontBytes:0});assert.equal(f.context.held,0);assert.deepEqual(f.context.backings,[]);assert.deepEqual(allocations(),before);
});

test('document release clears owned text, files, preview and native composition while preserving saved drafts and reusable bindings',async()=>{
 const f=fixture();await f.begin();await f.input('Saved unapplied text');
 f.field('<en-file-upload label="Font file"',{files:[new File(['font'],'chosen.ttf')]});
 f.field('<en-file-upload label="Font license record"',{files:[new File(['license'],'LICENSE.txt')]});await settle();
 f.click('Preview text');await until(()=>f.controller.lifecycle.previewBytes===4,'text preview');assert.equal(f.controller.lifecycle.retainedFiles,2);
 const activeBindings=()=>f.controller.control.listeners.filter(item=>!item.options?.signal?.aborted).length;const textarea=f.controller.control,bindings=activeBindings(),permanent=f.document.listeners.length,commands=f.commands.length;
 await f.input('Unfinished composition',true);assert(f.controller.composing);
 const saved=structuredClone([...f.drafts]),changeCount=f.changes.length;
 // An event already scheduled by the old controls cannot repopulate their files.
 f.field('<en-file-upload label="Font file"',{files:[new File(['late'],'late.ttf')]});
 await f.controller.releaseDocument();await settle();released(f.controller);assert.equal(f.context.held,0);assert.equal(f.canvas.width,0);assert.equal(f.canvas.height,0);assert(f.context.renderers.every(value=>value.disposed));
 assert.equal(activeBindings(),bindings);assert.equal(f.document.listeners.length,permanent);assert.deepEqual(f.clears,[]);assert.equal(f.commands.length,commands);
 assert.deepEqual([...f.drafts],saved);assert.equal(f.changes.length,changeCount);
 const durableBefore=structuredClone([...f.drafts]);await f.controller.releaseDocument();assert.deepEqual([...f.drafts],durableBefore);
 f.editor.view.document={...f.editor.view.document,id:'document-b'};await f.begin();assert.equal(f.controller.control,textarea);await f.input('New document text');assert.equal(JSON.parse(f.changes.at(-1).value).text,'New document text');assert.equal(f.changes.at(-1).revision,'1');assert.equal(f.drafts.size,2);
});

test('release drops an accepted preview buffer and its lease without changing the saved draft',async()=>{
 const f=fixture();await f.begin();await f.input('Retained preview');f.click('Preview text');await until(()=>f.controller.lifecycle.previewBytes===4,'retained preview');
 const saved=structuredClone([...f.drafts]);assert.equal(f.context.held,8+4096);assert.equal(f.canvas.width,1);
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
 const draft={id:'saved-draft',kind:'text',status:'saved-unapplied',documentId:'document-a',generation:'1',expectedDocumentRevision:'1',targetLayerId:null};f.editor.view.image.layers=[layer];f.editor.ui.drafts=mode==='saved draft'?[draft]:[];
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
 f.editor.view.image.layers=[layer];f.editor.ui.drafts=mode==='saved draft'?[draft]:[];f.editor.json=async()=>mode==='saved draft'?{draft,value:{kind:'text-draft-2',...source.text,placement:{x:0,y:0}}}:{source,layerVersion:'1'};f.editor.session.transport=()=>pending.promise;
 const starting=observe(mode==='existing layer'?f.controller.begin(new Element(f.document),layer):f.controller.sync());await flush();const first=observe(f.controller.releaseDocument());
 pending.resolve(new Response(new ReadableStream({cancel(){cancels++;if(failing)throw Error('BODY_CANCEL_FAILED');}}),{headers:{'Content-Length':'4'}}));await starting;assert.match((await first).error.message,/TEXT_DOCUMENT_RELEASE_FAILED/);assert.equal(f.controller.lifecycle.closing,false);assert.equal(cancels,1);assert.equal(f.controller.active,false);
 failing=false;await assert.rejects(f.controller.releaseDocument(),/TEXT_DOCUMENT_RELEASE_FAILED/);assert.equal(cancels,1);assert.equal(f.context.held,4*6+65536);f.context.expectedUnresolvedBytes=f.context.held;assert.equal(f.changes.length,0);assert.equal(f.commands.length,0);controllers.delete(f.controller); // No native API can retry the failed underlying callback.
});

for(const mode of ['existing layer','saved draft'])for(const reason of [Error('stored network error'),undefined])test('late already-errored '+mode+' response does not poison document cleanup: '+String(reason),async()=>{
 const f=fixture(),pending=deferred(),ref={hash:hash('text'),byteLength:'4',mediaType:'text/plain'},source={text:{textUtf8:ref,fonts:[font],style:{primaryFont:fontHash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1.2,fill:[0,0,0,255],align:'start',direction:'auto'},frame:{width:8,height:8}}};
 const layer={id:'layer',version:'1',kind:'text',name:'Retained',locked:false},draft={id:'draft',kind:'text',status:'saved-unapplied',documentId:'document-a',generation:'1',expectedDocumentRevision:'1',targetLayerId:null};
 f.editor.view.image.layers=[layer];f.editor.ui.drafts=mode==='saved draft'?[draft]:[];f.editor.json=async()=>mode==='saved draft'?{draft,value:{kind:'text-draft-2',...source.text,placement:{x:0,y:0}}}:{source,layerVersion:'1'};f.editor.session.transport=()=>pending.promise;
 const starting=observe(mode==='existing layer'?f.controller.begin(new Element(f.document),layer):f.controller.sync());await flush();const closing=f.controller.releaseDocument();
 const body=new ReadableStream({start(controller){controller.error(reason);}});pending.resolve(new Response(body,{headers:{'Content-Length':'4'}}));await starting;await closing;released(f.controller);assert.equal(body.locked,false);assert.equal(f.context.held,0);assert.equal(f.commands.length,0);
});

for(const mode of ['existing layer','saved draft'])for(const fault of ['cancel','unlock'])test(mode+' close during an active text body read preserves '+fault+' cleanup failure',async()=>{
 const f=fixture(),reading=deferred(),ref={hash:hash('text'),byteLength:'4',mediaType:'text/plain'},source={text:{textUtf8:ref,fonts:[font],style:{primaryFont:fontHash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1.2,fill:[0,0,0,255],align:'start',direction:'auto'},frame:{width:8,height:8}}};let failing=true,cancels=0,unlocks=0;
 const body=new ReadableStream({cancel(){cancels++;if(fault==='cancel'&&failing)throw Error('UNDERLYING_CANCEL_FAILED');}}),getReader=body.getReader.bind(body);
 body.getReader=()=>{const reader=getReader(),read=reader.read.bind(reader),unlock=reader.releaseLock.bind(reader);reader.read=()=>{reading.resolve();return read();};reader.releaseLock=()=>{unlocks++;if(fault==='unlock'&&failing)throw Error('UNLOCK_FAILED');unlock();};return reader;};
 const layer={id:'layer',version:'1',kind:'text',name:'Retained',locked:false},draft={id:'draft',kind:'text',status:'saved-unapplied',documentId:'document-a',generation:'1',expectedDocumentRevision:'1',targetLayerId:null};
 f.editor.view.image.layers=[layer];f.editor.ui.drafts=mode==='saved draft'?[draft]:[];f.editor.json=async()=>mode==='saved draft'?{draft,value:{kind:'text-draft-2',...source.text,placement:{x:0,y:0}}}:{source,layerVersion:'1'};f.editor.session.transport=async()=>({ok:true,headers:new Headers({'Content-Length':'4'}),body});
 const starting=observe(mode==='existing layer'?f.controller.begin(new Element(f.document),layer):f.controller.sync());await reading.promise;const closing=observe(f.controller.releaseDocument());await starting;assert.match((await closing).error.message,/TEXT_DOCUMENT_RELEASE_FAILED/);assert.equal(cancels,1);assert(unlocks>=1);assert.equal(f.context.held,4*6+65536);
 failing=false;if(fault==='unlock'){await f.controller.releaseDocument();released(f.controller);assert.equal(body.locked,false);assert.equal(f.context.held,0);}else{await assert.rejects(f.controller.releaseDocument(),/TEXT_DOCUMENT_RELEASE_FAILED/);assert.equal(cancels,1);assert.equal(f.context.held,4*6+65536);f.context.expectedUnresolvedBytes=f.context.held;controllers.delete(f.controller);}
 assert.equal(f.changes.length,0);assert.equal(f.commands.length,0);
});

test('release terminates preview workers immediately but waits for their result disposal before releasing the realm',async()=>{
 const f=fixture(),pending=deferred();await f.begin();await f.input('Preview text');f.context.render=()=>pending.promise;f.click('Preview text');await until(()=>f.context.activeRenderers===1,'pending renderer');
 f.context.events.length=0;let done=false;const releasing=f.controller.releaseDocument().then(()=>{done=true;});await flush();assert(f.context.renderers.every(value=>value.disposed));assert.equal(done,false);assert(!f.context.events.includes('realm-release'));
 pending.resolve({rgba:new Blob([new Uint8Array([1,2,3,255])]),rasterHash:hash('raster-preview'),overflow:false,width:1,height:1});await releasing;released(f.controller);assert.equal(f.context.held,0);
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

for(const status of [404,503])test('font HTTP '+status+' keeps its response owned until cancellation completes before reporting the load failure',async()=>{
 const f=fixture({native:false}),library=f.library(),before=allocations(),gate=deferred();let cancelled=0,settled=false;
 const body=new ReadableStream({cancel(){cancelled++;return gate.promise;}});
 f.editor.session.transport=async(path,options)=>{assert.equal(path,'/api/v1/assets/font-asset/content');assert.equal(options?.method??'GET','GET');return new Response(body,{status});};
 const loading=observe(library.load([font])).then(result=>{settled=true;return result;});
 try{await until(()=>cancelled===1,'font response cancellation');assert.equal(settled,false);assert.equal(body.locked,true);assert.equal(f.context.held,fontBytes.length*5+65536);assert.equal(library.lifecycle.pendingOperations,1);}finally{gate.resolve();}
 const {error}=await loading,{TextFailure}=await import(contracts);assert(error instanceof TextFailure);assert.equal(error.code,'TEXT_ASSET_LOAD');assert.deepEqual(error.details,{fontHTTPStatus:status});assert.equal(cancelled,1);assert.equal(body.locked,false);
 assert.deepEqual(library.lifecycle,{pendingOperations:0,retainedFontBytes:0});assert.equal(f.context.held,0);assert.deepEqual(f.context.backings,[]);assert.deepEqual(f.commands,[]);assert.deepEqual(f.stages,[]);assert.deepEqual(allocations(),before);
});

test('failed cancellation of an unavailable font response retains cleanup authority instead of HTTP retry guidance',async()=>{
 const f=fixture({native:false}),library=f.library();let cancelled=0;
 const body=new ReadableStream({cancel(){cancelled++;throw Error('FONT_RESPONSE_CANCEL_FAILED');}});
 f.editor.session.transport=async()=>new Response(body,{status:503});
 const {error}=await observe(library.load([font]));assert.equal(error.code,'TEXT_ASSET_CLEANUP');assert.match(error.details.message,/FONT_RESPONSE_CANCEL_FAILED/);assert.equal(cancelled,1);assert.equal(body.locked,false);
 assert.equal(f.context.held,fontBytes.length*5+65536);assert.deepEqual(f.context.backings,[]);await assert.rejects(library.releaseDocument(),/TEXT_LIBRARY_CLEANUP/);assert.equal(cancelled,1);assert.equal(f.context.held,fontBytes.length*5+65536);
 f.context.expectedUnresolvedBytes=f.context.held;libraries.delete(library); // A closed stream cannot retry the failed underlying cancellation.
});

for(const status of [404,503])test('native font HTTP '+status+' names the layer, retains its draft and clears the error only after a successful retry',async()=>{
 const f=fixture(),accepted='Accepted heading',textBytes=Buffer.from(accepted),layer={id:'headline-layer',version:'1',kind:'text',name:'Headline',locked:false,layerToDocument:[1,0,0,1,0,0]};
 const source={text:{textUtf8:{hash:hash(textBytes),byteLength:String(textBytes.length),mediaType:'text/plain'},fonts:[font],style:{primaryFont:fontHash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1.2,fill:[0,0,0,255],align:'start',direction:'auto'},frame:{width:8,height:8}}};
 f.editor.view.image.layers=[layer];f.editor.json=async()=>({source,layerVersion:'1'});f.editor.patch=patch=>Object.assign(f.editor.view,patch);f.editor.draftOwner.pendingRequests=()=>[];
 const transport=async(path,options)=>options?.method==='HEAD'?new Response(null):new Response(path.includes('&content=1')?textBytes:fontBytes,{headers:{'Content-Length':String(path.includes('&content=1')?textBytes.length:fontBytes.length)}});
 f.editor.session.transport=transport;await f.controller.begin(new Element(f.document),layer);await until(()=>f.controller.lifecycle.pendingOperations===0,'opened retained layer');await f.input('Full current draft');
 const saved=structuredClone([...f.drafts]),session=f.controller.session,changes=f.changes.length,commands=f.commands.length;let failedGets=0,cancelled=0;
 f.editor.session.transport=async(path,options)=>{if(path==='/api/v1/assets/font-asset/content'&&(options?.method??'GET')==='GET'){failedGets++;return new Response(new ReadableStream({cancel(){cancelled++;}}),{status});}return transport(path,options);};
 const message='Headline: '+(status===404?'Missing exact font bytes. Draft and accepted appearance are retained; relink the exact font or preview a substitution.':'Text resources are unavailable. Draft and accepted appearance are retained; retry Preview text when the local service is available.');
 f.click('Preview text');await until(()=>f.editor.view.error===message&&f.controller.lifecycle.pendingOperations===0,'font load guidance');await flush();
 assert.equal(failedGets,1);assert.equal(cancelled,1);assert.equal(f.controller.error,message);assert.equal(find(f.template(),'id="native-text-error"').values[0],message);assert.equal(f.editor.view.message,'Action needs attention.');assert.deepEqual(f.errors,[]);
 assert.equal(f.controller.control.getAttribute('aria-invalid'),'true');assert.equal(f.controller.control.getAttribute('aria-errormessage'),'native-text-error');assert.equal(f.controller.control.getAttribute('aria-describedby'),'native-text-policy native-text-error');
 assert.equal(f.controller.session,session);assert.equal(f.controller.control.value,'Full current draft');assert.equal(f.controller.session.name,'Headline');assert.deepEqual([...f.drafts],saved);assert.equal(f.changes.length,changes);assert.equal(f.commands.length,commands);assert.equal(f.context.held,0);assert.equal(f.context.events.includes('renderer-start'),false);
 let retryText='Full current draft',retrySession=session,retrySaved=saved,retryChanges=changes;
 if(status===503){retryText='Revised current draft';await f.input(retryText);retrySession=f.controller.session;retrySaved=structuredClone([...f.drafts]);retryChanges=f.changes.length;assert.equal(retrySession.draftId,session.draftId);assert.equal(f.controller.error,message);assert.equal(f.controller.control.getAttribute('aria-invalid'),'true');assert.equal(f.controller.control.getAttribute('aria-errormessage'),'native-text-error');assert.equal(f.controller.lifecycle.previewBytes,0);assert.equal(f.commands.length,commands);}
 let renderedText;const render=f.context.render;f.context.render=request=>{renderedText=request.text;return render(request);};
 f.editor.session.transport=transport;f.click('Preview text');await until(()=>f.controller.lifecycle.previewBytes===4&&f.controller.lifecycle.pendingOperations===0,'retried preview');await flush();
 assert.equal(f.controller.message,'Text preview ready. Accepted appearance is unchanged.');assert.equal(f.controller.error,'');assert.equal(find(f.template(),'id="native-text-error"'),undefined);assert.equal(f.controller.control.getAttribute('aria-invalid'),'false');assert.equal(f.controller.control.getAttribute('aria-errormessage'),null);assert.equal(f.controller.control.getAttribute('aria-describedby'),'native-text-policy');
 assert.equal(renderedText,retryText);assert.equal(f.controller.session,retrySession);assert.equal(f.controller.control.value,retryText);assert.deepEqual([...f.drafts],retrySaved);assert.equal(f.changes.length,retryChanges);assert.equal(f.commands.length,commands);assert.deepEqual(f.errors,[]);
});

test('late unavailable font response drains during release and cannot install an error in a fresh native session',async()=>{
 const f=fixture(),pending=deferred(),patches=[];await f.begin();await f.input('Retained previous draft');
 const transport=f.editor.session.transport,saved=structuredClone([...f.drafts]),priorDraft=f.controller.session.draftId,commands=f.commands.length;let signal,cancelled=0,done=false;
 f.editor.patch=patch=>{patches.push(patch);Object.assign(f.editor.view,patch);};f.editor.draftOwner.pendingRequests=()=>[];
 f.editor.session.transport=(path,options)=>{if(path==='/api/v1/assets/font-asset/content'&&(options?.method??'GET')==='GET'){signal=options.signal;return pending.promise;}return transport(path,options);};
 f.click('Preview text');await until(()=>signal instanceof AbortSignal,'pending font GET');
 const body=new ReadableStream({cancel(){cancelled++;}}),releasing=f.controller.releaseDocument().then(()=>{done=true;});
 try{assert.equal(f.context.held,fontBytes.length*5+65536);await flush();assert.equal(signal.aborted,true);assert.equal(done,false);assert.equal(f.controller.lifecycle.closing,true);assert.equal(f.controller.active,false);await f.controller.begin(new Element(f.document));assert.equal(f.controller.active,false);assert.equal(f.commands.length,commands);}finally{pending.resolve(new Response(body,{status:503}));}
 await releasing;await settle();released(f.controller);
 assert.equal(cancelled,1);assert.equal(body.locked,false);assert.equal(f.context.held,0);assert.deepEqual(allocations(),{cpuBytes:0,gpuBytes:0,previewCacheBytes:0,handles:0,activeRecords:0});assert.deepEqual([...f.drafts],saved);assert.equal(f.commands.length,commands);assert.deepEqual(patches,[]);assert.deepEqual(f.errors,[]);assert.equal(f.controller.error,'');assert.equal(f.controller.fontLoadFailed,false);assert.equal(f.controller.control.getAttribute('aria-invalid'),'false');assert.equal(f.controller.control.getAttribute('aria-errormessage'),null);
 f.editor.session.transport=transport;f.editor.sessionId='session-b';f.editor.view.document={...f.editor.view.document,id:'document-b'};await f.begin();await f.input('Fresh session text');
 assert.notEqual(f.controller.session.draftId,priorDraft);assert.equal(f.controller.session.id,'session-b');assert.equal(f.controller.error,'');assert.equal(f.controller.fontLoadFailed,false);assert.equal(f.controller.control.getAttribute('aria-invalid'),'false');assert.equal(f.controller.control.getAttribute('aria-errormessage'),null);assert.equal(f.controller.control.getAttribute('aria-describedby'),'native-text-policy');
 f.click('Preview text');await until(()=>f.controller.lifecycle.previewBytes===4&&f.controller.lifecycle.pendingOperations===0,'fresh session preview');assert.equal(f.controller.message,'Text preview ready. Accepted appearance is unchanged.');assert.equal(f.controller.control.value,'Fresh session text');assert.equal(f.controller.error,'');assert.equal(f.controller.fontLoadFailed,false);assert.deepEqual(patches,[]);assert.deepEqual(f.errors,[]);assert.equal(f.commands.filter(command=>['CreateTextLayer','CommitTextEdit','ReplaceTextFont'].includes(command.type)).length,0);
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
 const f=fixture({native:false}),library=f.library();const first=await library.load([font]);assert.equal(first.value.length,1);assert.equal(library.lifecycle.retainedFontBytes,fontBytes.length);assert.equal(f.context.held,fontBytes.length);
 first.release();await library.releaseDocument();assert.deepEqual(library.lifecycle,{pendingOperations:0,retainedFontBytes:0});assert.equal(f.context.held,0);
 const second=await library.load([font]);assert.equal(second.value.length,1);assert.notEqual(second.value[0].bytes,first.value[0].bytes);assert.equal(library.lifecycle.retainedFontBytes,fontBytes.length);second.release();
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
 const f=fixture();await f.begin();const setupCommands=structuredClone(f.commands);assert.deepEqual(setupCommands.map(command=>command.type),['ImportFont']);observedPhases.recorder.drain().release();
 await f.input('private native text never belongs in telemetry',true);
 const records=phaseSnapshot().records,editing=records.find(x=>x.phase==='text.edit');
 assert(editing);assert.equal(editing.outcome,'incomplete');assert.equal(editing.context.boundary,'render-submitted');assert.equal(editing.context.inputSource,'synthetic-event');assert.equal(editing.context.composing,true);
 assert.equal(JSON.stringify(records).includes('private native text'),false);assert.deepEqual(f.commands,setupCommands);
});

test('rejected Apply reports its attempted layout without replacing the draft or recording text',async()=>{
 const f=fixture();await f.begin();const setupCommands=structuredClone(f.commands);assert.deepEqual(setupCommands.map(command=>command.type),['ImportFont']);await f.input('retained private draft');observedPhases.recorder.drain().release();
 f.click('Apply text');await settle();
 const records=phaseSnapshot().records,layout=records.find(x=>x.phase==='text.layout');
 assert(layout);assert.equal(layout.outcome,'error');assert.equal(layout.context.documentId,'document-a');assert.equal(layout.context.revision,'1');
 assert.equal(JSON.stringify(records).includes('retained private draft'),false);assert.equal(f.controller.control.value,'retained private draft');assert.deepEqual(f.commands,setupCommands);
});

test('preview diagnostics bind the actual request and submitted pixels while remaining incomplete',async()=>{
 const f=fixture();await f.begin();await f.input('Private preview source');observedPhases.recorder.drain().release();
 const session=f.controller.session,generation=Number(f.drafts.get(session.draftId).generation);
 f.click('Preview text');await until(()=>phaseSnapshot().records.some(row=>row.phase==='text.layout'),'preview submission phase');
 const rows=phaseSnapshot().records.filter(row=>row.phase==='text.layout');assert.equal(rows.length,1);const row=rows[0];
 assert.equal(row.outcome,'incomplete');assert.equal(row.context.boundary,'render-submitted');assert.equal(row.context.documentId,session.document.id);assert.equal(row.context.revision,session.document.revision);assert.equal(row.context.layerId,session.layerId);assert.equal(row.context.sessionId,session.id);assert.equal(row.context.snapshotId,session.draftId);assert.equal(row.context.generation,generation);
 assert.equal(row.context.previewId,f.controller.preview.id);assert.equal(row.context.assetHash,hash('raster-preview'));assert.equal(row.context.evidenceHash,hash('dependencies'));assert.equal(row.context.width,1);assert.equal(row.context.height,1);assert.equal(f.canvas.width,1);assert.equal(f.controller.preview.textHash,hash('Private preview source'));assert.equal(f.controller.preview.layerVersion,session.layerVersion);assert.equal(f.context.held,8+4096);
 const view=f.template();for(const name of ['data-text-session-id','data-text-document-id','data-text-document-revision','data-text-layer-id','data-text-layer-version','data-text-generation','data-text-saved-generation','data-preview-id','data-preview-generation','data-preview-layer-version','data-preview-text-hash','data-preview-dependency-hash','data-preview-raster-hash','data-preview-width','data-preview-height'])assert(find(view,name),name);
 assert.equal(JSON.stringify(rows).includes('Private preview source'),false);await f.controller.releaseDocument();assert.equal(f.context.held,0);
});

test('missing preview canvas and stale native renderer completion cannot report render submission',async()=>{
 const f=fixture();await f.begin();await f.input('Preview without target');observedPhases.recorder.drain().release();
 const query=f.host.querySelector;f.host.querySelector=selector=>selector==='#native-text-preview'?null:query(selector);
 f.click('Preview text');await until(()=>f.errors.length>0,'missing preview canvas');
 let rows=phaseSnapshot().records.filter(row=>row.phase==='text.layout');assert.equal(rows.length,1);assert.equal(rows[0].outcome,'error');assert.equal(rows[0].context.boundary,undefined);
 f.host.querySelector=query;await f.input('Before pending native layout');const gate=deferred();f.context.render=()=>gate.promise;observedPhases.recorder.drain().release();f.click('Preview text');await until(()=>f.context.activeRenderers===1,'pending native layout');await f.input('New current native input');
 gate.resolve({rgba:new Blob([new Uint8Array([1,2,3,255])]),rasterHash:hash('late'),textHash:hash('Before pending native layout'),dependencyHash:hash('dependencies'),overflow:false,width:1,height:1});await until(()=>f.controller.lifecycle.pendingOperations===0,'stale layout drain');
 rows=phaseSnapshot().records.filter(row=>row.phase==='text.layout');assert.equal(rows.length,1);assert.notEqual(rows[0].outcome,'incomplete');assert.equal(rows[0].context.boundary,undefined);assert.equal(f.controller.preview,undefined);assert.equal(f.canvas.width,0);
});

test('Apply diagnostics preserve preview identity and bind the actual saved generation and durable receipt',async()=>{
 // Match EditorClient.changeDraft's exact retained-input fast path. The legacy
 // fixture's unconditional increment is not the real Apply generation rule.
 const f=fixture({actualChangeDraft:true});await f.begin();await f.input('Exact Apply source');observedPhases.recorder.drain().release();
 f.context.prepare=async(_request,_fonts,storage)=>{const candidate=await storage.stage(new Blob([JSON.stringify({source:{render:{pixels:{hash:hash('raster-preview')}}}})]),'application/json');return {candidate,admissionId:'admission',dependencyHash:hash('dependencies')};};
 const command=f.editor.command;let actual;
 f.editor.command=async body=>{if(body.type==='CreateTextLayer'){actual=body;return [{type:'ImageEdited',commandId:'text-command',correlationId:'text-correlation',transactionId:'text-transaction',resultingDocumentRevision:'2'}];}return command.call(f.editor,body);};
 f.click('Preview text');await until(()=>phaseSnapshot().records.some(row=>row.phase==='text.layout'&&row.context.previewId===f.controller.preview?.id),'prepared Apply preview');const preview=f.controller.preview.id,generation=f.controller.preview.generation;observedPhases.recorder.drain().release();
 f.click('Apply text');await until(()=>!f.controller.active&&f.controller.lifecycle.pendingOperations===0,'durable Apply');
 const rows=phaseSnapshot().records.filter(row=>row.phase==='text.layout');assert.equal(rows.length,1);const row=rows[0];assert.equal(row.outcome,'incomplete');assert.equal(row.context.boundary,'authority-durable');assert.equal(row.context.previewId,preview);assert.equal(row.context.generation,generation);assert.equal(String(row.context.generation),actual.draft.generation);assert.equal(row.context.snapshotId,actual.draft.draftId);assert.equal(row.context.sessionId,actual.draft.sessionId);assert.equal(row.context.commandId,'text-command');assert.equal(row.context.correlationId,'text-correlation');assert.equal(row.context.transactionId,'text-transaction');assert.equal(row.context.resultingRevision,'2');assert.equal(row.context.evidenceHash,hash('dependencies'));assert.equal(row.context.assetHash,hash('raster-preview'));assert.equal(f.context.held,0);assert.equal(f.errors.length,0);
});

test('native opening admits a thin independent document snapshot before deferred font work',async()=>{
 const f=fixture(),pending=deferred(),document=f.editor.view.document;document.orderedLayerIds=Array.from({length:4096},(_,i)=>'unneeded-layer-'+i);document.image={state:{large:'unneeded'.repeat(10000)}};
 f.context.readSealedAsset=()=>pending.promise;const beginning=f.controller.begin(new Element(f.document));await flush();assert.equal(f.context.viewPins,0);assert.equal(f.context.viewPinCalls.length,1);assert.equal(f.context.viewPinCalls[0][0],document);assert.equal(f.controller.lifecycle.controlMemory.actions,1);assert.equal(f.controller.lifecycle.controlMemory.models,1);assert(allocations().activeRecords>=3);
 document.width=99;document.height=101;pending.resolve(new Blob([fontBytes]));await beginning;await settle();const snapshot=f.controller.session.document;
 assert.notEqual(snapshot,document);assert.deepEqual(snapshot,{id:'document-a',revision:'1',width:32,height:32});assert.deepEqual(Object.keys(snapshot).sort(),['height','id','revision','width']);assert(allocations().cpuBytes<32768);assert.equal(f.context.viewPins,0);
});

test('unadmitted layer identity fails before font or snapshot allocation',async()=>{
 const f=fixture(),before=allocations();await assert.rejects(f.controller.begin(new Element(f.document),{id:'foreign',version:'1',kind:'text',name:'Unknown',locked:false}),/VIEW_MODEL_UNOWNED/);assert.deepEqual(allocations(),before);assert.equal(f.stages.length,0);assert.equal(f.context.viewPins,0);
});

test('saved native draft scalars are copied before the first metadata await',async()=>{
 const f=fixture(),pending=deferred(),text='saved text',draft={id:'original-draft',kind:'text',status:'saved-unapplied',documentId:'document-a',generation:'1',expectedDocumentRevision:'1',targetLayerId:null};
 const original=structuredClone(draft);f.editor.ui.drafts=[draft];f.editor.json=()=>pending.promise;f.editor.session.transport=async()=>new Response(text,{headers:{'Content-Length':String(Buffer.byteLength(text))}});
 const restoring=f.controller.sync();await flush();assert.equal(f.context.viewPins,0);draft.id='replaced-draft';draft.expectedDocumentRevision='999';f.editor.view.document.width=100;
 pending.resolve({draft:original,value:{kind:'text-draft-2',textUtf8:{hash:hash(text),byteLength:String(Buffer.byteLength(text)),mediaType:'text/plain'},fonts:[font],style:{primaryFont:fontHash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1.2,fill:[0,0,0,255],align:'start',direction:'auto'},frame:{width:8,height:8},placement:{x:0,y:0}}});
 await restoring;await settle();assert.equal(f.controller.session.draftId,'original-draft');assert.deepEqual(f.controller.session.document,{id:'document-a',revision:'1',width:32,height:32});assert.equal(f.controller.control.value,text);
});

test('retired session snapshot stays admitted until a pending action settles',async()=>{
 const f=fixture(),pending=deferred();await f.begin();const work=f.controller.run('Held native action',()=>pending.promise);await flush();const closing=f.controller.releaseDocument();await settle();assert.equal(f.controller.active,false);assert.equal(f.context.held,0);assert(f.controller.lifecycle.controlMemory.models>=1);assert(allocations().activeRecords>=1);
 pending.resolve();await Promise.all([work,closing]);assert.equal(allocations().activeRecords,0);
});

test('retired rendered snapshot stays admitted until the replacement commits',async()=>{
 const f=fixture(),commit=deferred();await f.begin();const update=f.host.requestUpdate;f.host.requestUpdate=()=>{f.host.updateComplete=commit.promise.then(()=>{f.controller.render();});};
 let done=false;const closing=f.controller.releaseDocument().then(()=>{done=true;});await flush();assert.equal(done,false);assert.equal(f.controller.active,false);assert.equal(f.context.held,0);assert(f.controller.lifecycle.controlMemory.models>=1);assert(allocations().activeRecords>=1);
 commit.resolve();await closing;f.host.requestUpdate=update;assert.equal(allocations().activeRecords,0);
});

test('failed replacement commit retains its snapshot for an explicit release retry',async()=>{
 const f=fixture();await f.begin();const update=f.host.requestUpdate;f.host.requestUpdate=()=>{f.host.updateComplete=Promise.reject(Error('LIT_COMMIT_FAILED'));void f.host.updateComplete.catch(()=>{});};
 await assert.rejects(f.controller.releaseDocument(),/TEXT_DOCUMENT_RELEASE_FAILED/);assert(f.controller.lifecycle.controlMemory.models>=1);assert(allocations().activeRecords>=1);assert.equal(f.controller.active,false);
 f.host.requestUpdate=update;await f.controller.releaseDocument();assert.equal(allocations().activeRecords,0);
});

test('an old rendered writer cannot mutate a reopened native session',async()=>{
 const f=fixture();await f.begin();const size=find(f.template(),'<en-number-field');const callback=size.values.find(value=>typeof value==='function');assert.equal(typeof callback,'function');
 await f.controller.releaseDocument();f.editor.view.document={id:'document-b',revision:'1',width:32,height:32};await f.begin();const placement=structuredClone(f.controller.session.placement),changes=f.changes.length;
 callback(event({isConnected:true,value:'999'}));await settle();assert.deepEqual(f.controller.session.placement,placement);assert.equal(f.changes.length,changes);assert.equal(f.context.viewPins,0);
});

test('snapshot admission refusal leaves saved-draft restoration retryable after capacity returns',async()=>{
 const f=fixture(),text='saved text',draft={id:'retry-draft',kind:'text',status:'saved-unapplied',documentId:'document-a',generation:'1',expectedDocumentRevision:'1',targetLayerId:null};f.editor.ui.drafts=[draft];
 f.editor.json=async()=>({draft,value:{kind:'text-draft-2',textUtf8:{hash:hash(text),byteLength:String(Buffer.byteLength(text)),mediaType:'text/plain'},fonts:[font],style:{primaryFont:fontHash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1.2,fill:[0,0,0,255],align:'start',direction:'auto'},frame:{width:8,height:8},placement:{x:0,y:0}}});f.editor.session.transport=async()=>new Response(text,{headers:{'Content-Length':String(Buffer.byteLength(text))}});
 const pressure=allocationLedger.reserve({owner:'native-view-test-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-allocationLedger.snapshot().cpuBytes});
 try{await assert.rejects(f.controller.sync(),/ALLOCATION_BUDGET/);assert.equal(f.controller.active,false);assert.equal(f.context.viewPins,0);}finally{pressure.release();}
 await f.controller.sync();await settle();assert.equal(f.controller.active,true);assert.equal(f.controller.session.draftId,'retry-draft');assert.equal(f.controller.control.value,text);
});

for(const boundary of ['draft metadata','text content','original source'])test('saved draft restore rejects a changed UI session after '+boundary,async()=>{
 const f=fixture(),pending=deferred(),reached=deferred(),text='prior owner text',ref={hash:hash(text),byteLength:String(Buffer.byteLength(text)),mediaType:'text/plain'},layer={id:'layer-a',version:'1',kind:'text',name:'Text',locked:false};
 const draft={id:'owner-draft',kind:'text',status:'saved-unapplied',documentId:'document-a',generation:'1',expectedDocumentRevision:'1',targetLayerId:boundary==='original source'?layer.id:null};
 const value={kind:'text-draft-2',textUtf8:ref,fonts:[font],style:{primaryFont:fontHash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1.2,fill:[0,0,0,255],align:'start',direction:'auto'},frame:{width:8,height:8},placement:{x:0,y:0}};
 f.editor.ui.drafts=[draft];f.editor.view.image.layers=[layer];let contentReads=0,sourceReads=0;
 f.editor.json=async path=>{if(path.startsWith('/api/v1/ui/')){if(boundary==='draft metadata'){reached.resolve();return pending.promise;}return {draft,value};}sourceReads++;reached.resolve();return pending.promise;};
 f.editor.session.transport=async()=>{contentReads++;if(boundary==='text content'){reached.resolve();return pending.promise;}return new Response(text,{headers:{'Content-Length':ref.byteLength}});};
 const restoring=f.controller.sync();await reached.promise;f.editor.sessionId='session-b';pending.resolve(boundary==='draft metadata'?{draft,value}:boundary==='text content'?new Response(text,{headers:{'Content-Length':ref.byteLength}}):{source:{text:value}});
 await restoring;await settle();assert.equal(f.controller.active,false);assert.equal(f.controller.control.value,'');assert.deepEqual(f.changes,[]);assert.deepEqual(f.commands,[]);assert.equal(f.context.viewPins,0);assert.equal(allocations().activeRecords,0);
 if(boundary==='draft metadata')assert.equal(contentReads,0);if(boundary!=='original source')assert.equal(sourceReads,0);
});


test('same-document revision drift during restore releases its marker for a later recovery',async()=>{
 const f=fixture(),pending=deferred(),text='recover after revision changed',draft={id:'revision-retry',kind:'text',status:'saved-unapplied',documentId:'document-a',generation:'1',expectedDocumentRevision:'1',targetLayerId:null};
 const value={kind:'text-draft-2',textUtf8:{hash:hash(text),byteLength:String(Buffer.byteLength(text)),mediaType:'text/plain'},fonts:[font],style:{primaryFont:fontHash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1.2,fill:[0,0,0,255],align:'start',direction:'auto'},frame:{width:8,height:8},placement:{x:0,y:0}};
 f.editor.ui.drafts=[draft];f.editor.json=()=>pending.promise;let reads=0;f.editor.session.transport=async()=>{reads++;return new Response(text,{headers:{'Content-Length':value.textUtf8.byteLength}});};
 const restoring=f.controller.sync();await flush();f.editor.view.document.revision='2';pending.resolve({draft,value});await restoring;await settle();assert.equal(f.controller.active,false);assert.equal(reads,0);assert.equal(allocations().activeRecords,0);
 f.editor.json=async()=>({draft,value});await f.controller.sync();await settle();assert.equal(f.controller.active,true);assert.equal(f.controller.control.value,text);assert.equal(f.controller.session.document.revision,'1');assert.equal(f.controller.stale,true,'Recovered older draft stays visibly stale against the changed document');
});


test('a superseding failed opening cannot strand an older restore marker',async()=>{
 const f=fixture(),pending=deferred(),text='restore after failed opening',draft={id:'superseded-retry',kind:'text',status:'saved-unapplied',documentId:'document-a',generation:'1',expectedDocumentRevision:'1',targetLayerId:null};
 const value={kind:'text-draft-2',textUtf8:{hash:hash(text),byteLength:String(Buffer.byteLength(text)),mediaType:'text/plain'},fonts:[font],style:{primaryFont:fontHash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1.2,fill:[0,0,0,255],align:'start',direction:'auto'},frame:{width:8,height:8},placement:{x:0,y:0}};
 f.editor.ui.drafts=[draft];f.editor.json=()=>pending.promise;const restoring=f.controller.sync();await flush();f.context.readSealedAsset=async()=>{throw Error('OPEN_FONT_UNAVAILABLE');};await assert.rejects(f.controller.begin(new Element(f.document)),/OPEN_FONT_UNAVAILABLE/);pending.resolve({draft,value});await restoring;await settle();assert.equal(f.controller.active,false);assert.equal(allocations().activeRecords,f.controller.lifecycle.controlMemory.models);
 f.editor.json=async()=>({draft,value});f.editor.session.transport=async()=>new Response(text,{headers:{'Content-Length':value.textUtf8.byteLength}});await f.controller.sync();await settle();assert.equal(f.controller.active,true);assert.equal(f.controller.control.value,text);
});

// This helper dispatches the actual rendered toggle callback. Its dynamic label
// proves the next request derives from the pending target during composition.
function presentationButton(template){
 if(!template||typeof template!=='object')return;
 if(template.strings){const index=template.values.findIndex(value=>value==='Continue in inspector'||value==='Return to card');if(index>0&&typeof template.values[index-1]==='function')return {label:template.values[index],callback:template.values[index-1]};}
 for(const item of Array.isArray(template)?template:template.values??[]){const value=presentationButton(item);if(value)return value;}
}
async function togglePresentation(f){const button=presentationButton(f.template());assert(button,'Rendered presentation toggle');button.callback(event());await settle();return button.label;}

test('composition keeps one textarea and settles only the latest opposite pending presentation',async()=>{
 const f=fixture();await f.begin();const textarea=f.controller.control;await f.input('composing text',true);assert.equal(f.controller.presentation,'anchored');
 assert.equal(await togglePresentation(f),'Continue in inspector');const first={...f.controller.pendingSwitch},firstOwner=f.controller.pendingSwitchOwner;assert(firstOwner);assert.equal(first.target,'inspector');assert.equal(first.textRevision,f.controller.textRevision);assert.equal(f.controller.switchRequestTextVersion,first.textRevision);assert.equal(f.controller.presentation,'anchored');assert.equal(f.controller.switchSettled,0);
 assert.equal(await togglePresentation(f),'Return to card');const latest={...f.controller.pendingSwitch},latestOwner=f.controller.pendingSwitchOwner;assert(latestOwner);assert.notEqual(latestOwner,firstOwner);assert.throws(()=>{const release=firstOwner.pin();release();},/NATIVE_CONTROL_RELEASED/);assert.equal(latest.target,'anchored');assert.equal(latest.sequence,first.sequence+1);assert.equal(f.controller.switchSuperseded,first.sequence);assert.equal(f.controller.switchRejected,first.sequence);assert.equal(f.controller.switchRejectedGuards,0);assert.equal(f.controller.switchReason,'superseded');assert.equal(f.controller.presentation,'anchored');assert.equal(f.controller.switchSettled,0);
 f.controller.control.dispatchEvent(new Event('compositionend'));await f.input('composing text');await until(()=>f.controller.lifecycle.pendingOperations===0,'completed pending presentation');assert.equal(f.controller.composing,false);assert.equal(f.controller.pendingSwitch,undefined);assert.equal(f.controller.pendingSwitchOwner,undefined);assert.throws(()=>{const release=latestOwner.pin();release();},/NATIVE_CONTROL_RELEASED/);assert.equal(f.controller.switchRequestSequence,latest.sequence);assert.equal(f.controller.switchSettled,latest.sequence);assert.equal(f.controller.presentation,'anchored');assert.equal(f.controller.control,textarea);
});

test('a real native composing mutation rejects the exact deferred generation without moving presentation',async()=>{
 const f=fixture();await f.begin();await f.input('preedit',true);await togglePresentation(f);const token={...f.controller.pendingSwitch},owner=f.controller.pendingSwitchOwner;assert(owner);await f.input('changed preedit',true);
 assert.equal(f.controller.pendingSwitch,undefined);assert.equal(f.controller.presentation,'anchored');assert.equal(f.controller.switchSettled,0);assert.equal(f.controller.switchRejected,token.sequence);assert.equal(f.controller.switchRejectedEpoch,token.epoch);assert.equal(f.controller.switchRejectedGeneration,token.revision);assert.equal(f.controller.switchRejectedCurrentEpoch,token.epoch);assert.equal(f.controller.switchRejectedCurrentGeneration,token.revision+1);assert.equal(f.controller.switchReason,'stale-generation');
 assert.equal(f.controller.switchRejectedTextVersion,token.textRevision);assert.equal(f.controller.switchRejectedCurrentTextVersion,token.textRevision+1);assert.equal(f.controller.switchRejectedGuards,6);assert.equal(f.controller.pendingSwitchOwner,undefined);assert.throws(()=>owner.pin(),/NATIVE_CONTROL_RELEASED/);
 f.controller.control.dispatchEvent(new Event('compositionend'));await f.input('changed preedit');assert.equal(f.controller.presentation,'anchored');assert.equal(f.controller.switchSettled,0);
});

for(const owner of ['session','document revision','layer version'])test('deferred presentation rejects a changed '+owner+' independently of generation',async()=>{
 const f=fixture();await f.begin();if(owner==='layer version'){f.controller.session.original={};f.editor.view.image.layers=[{id:f.controller.session.layerId,version:f.controller.session.layerVersion,layerToDocument:[1,0,0,1,0,0]}];}
 await f.input('unchanged preedit',true);await togglePresentation(f);const token={...f.controller.pendingSwitch},pendingOwner=f.controller.pendingSwitchOwner;assert(pendingOwner);
 if(owner==='session')f.editor.sessionId='another-session';else if(owner==='document revision')f.editor.view.document.revision='2';else f.editor.view.image.layers[0].version='2';
 f.controller.control.dispatchEvent(new Event('compositionend'));await f.input('unchanged preedit');assert.equal(f.controller.pendingSwitch,undefined);assert.equal(f.controller.presentation,'anchored');assert.equal(f.controller.switchSettled,0);assert.equal(f.controller.switchRejected,token.sequence);assert.equal(f.controller.switchRejectedGeneration,token.revision);assert.equal(f.controller.switchRejectedCurrentGeneration,token.revision);assert.equal(f.controller.switchReason,owner==='session'?'stale-session':'stale-version');
 assert.equal(f.controller.switchRejectedTextVersion,token.textRevision);assert.equal(f.controller.switchRejectedCurrentTextVersion,token.textRevision);assert.equal(f.controller.switchRejectedGuards,owner==='session'?1:8);assert.equal(f.controller.pendingSwitchOwner,undefined);assert.throws(()=>pendingOwner.pin(),/NATIVE_CONTROL_RELEASED/);
});

test('format-only edits advance generation but preserve the independent native text version',async()=>{
 const f=fixture();await f.begin();await f.input('unchanged formatted preedit',true);await togglePresentation(f);const token={...f.controller.pendingSwitch},accepted=structuredClone(f.editor.view.document);
 f.field('<en-number-field',{value:'12'});await settle();assert.equal(f.controller.session.placement.x,12);assert.equal(f.controller.revision,token.revision+1);assert.equal(f.controller.textRevision,token.textRevision);assert.equal(f.controller.switchReason,'stale-generation');assert.equal(f.controller.switchRejectedGuards,2);assert.equal(f.controller.switchRejectedTextVersion,token.textRevision);assert.equal(f.controller.switchRejectedCurrentTextVersion,token.textRevision);
 const revision=f.controller.revision;await f.input('unchanged formatted preedit',true);assert.equal(f.controller.revision,revision);assert.equal(f.controller.textRevision,token.textRevision);await f.input('actual native replacement',true);assert.equal(f.controller.revision,revision+1);assert.equal(f.controller.textRevision,token.textRevision+1);assert.deepEqual(f.editor.view.document,accepted);
});

test('isolated text-only captured-token mismatch rejects independently of generation and accepted versions',async()=>{
 const f=fixture();await f.begin();await f.input('first native text',true);await togglePresentation(f);const captured={...f.controller.pendingSwitch},accepted=structuredClone(f.editor.view.document);await f.input('second native text',true);
 // Artificial isolated guard probe: preserve the real request identity/text
 // version, aligning only its generation after actual native input. This is
 // controller coverage, not a timed IText action or an OS IME observation.
 const isolated={...captured,revision:f.controller.revision};assert.notEqual(isolated.textRevision,f.controller.textRevision);assert.equal(isolated.epoch,f.controller.epoch);f.controller.switchTo(isolated.target,isolated);await flush();
 assert.equal(f.controller.switchRejected,isolated.sequence);assert.equal(f.controller.switchReason,'stale-text-version');assert.equal(f.controller.switchRejectedGuards,4);assert.equal(f.controller.switchRejectedGeneration,f.controller.switchRejectedCurrentGeneration);assert.equal(f.controller.switchRejectedEpoch,f.controller.switchRejectedCurrentEpoch);assert.equal(f.controller.switchRejectedTextVersion,isolated.textRevision);assert.equal(f.controller.switchRejectedCurrentTextVersion,isolated.textRevision+1);assert.equal(f.controller.pendingSwitch,undefined);assert.equal(f.controller.pendingSwitchOwner,undefined);assert.equal(f.controller.switchSettled,0);assert.equal(f.controller.presentation,'anchored');assert.deepEqual(f.editor.view.document,accepted);
});

test('explicit composition Cancel retains its real intent until native end and releases its owner before asynchronous cleanup',async()=>{
 const f=fixture(),cleanup=deferred();await f.begin();const textarea=f.controller.control,accepted=structuredClone(f.editor.view.document);await f.input('before composition');await f.input('preedit cancellation',true);await togglePresentation(f);const pending=f.controller.pendingSwitch,token={...pending},owner=f.controller.pendingSwitchOwner;assert(owner);const rejected=f.controller.switchRejected;
 f.click('Cancel text edit');await settle();assert.equal(f.controller.pendingAction,'cancel');assert.equal(f.controller.cancelIntentEpoch,token.epoch);assert.equal(f.controller.pendingSwitchCancelled,true);assert.equal(f.controller.pendingSwitch,pending);assert.equal(f.controller.pendingSwitchOwner,owner);assert.equal(f.controller.active,true);assert.equal(f.controller.composing,true);assert.equal(f.controller.presentation,'anchored');assert.equal(f.controller.switchSettled,0);assert.equal(f.controller.switchRejected,rejected);
 f.context.events.length=0;f.context.releaseRealm=()=>cleanup.promise;
 try{
  // Observe the real synchronous native restore before the deferred Cancel
  // callback runs. No extra presentation request or accepted mutation occurs.
  textarea.value='before composition';const restore=new Event('input');Object.defineProperties(restore,{isComposing:{value:false},inputType:{value:'insertText'}});textarea.dispatchEvent(restore);await flush();
  assert.equal(f.controller.pendingSwitch,pending);assert.equal(f.controller.pendingSwitchOwner,owner);assert.equal(f.controller.pendingSwitchCancelled,true);assert.equal(f.controller.epoch,token.epoch);assert.equal(f.controller.revision,token.revision+1);assert.equal(f.controller.textRevision,token.textRevision+1);assert.equal(f.controller.switchRejected,rejected);assert.equal(f.controller.switchSettled,0);assert.equal(f.clears.length,0);
  textarea.dispatchEvent(new Event('compositionend'));await until(()=>f.context.events.includes('realm-release'),'Cancel entered asynchronous cleanup');
  assert.equal(f.controller.active,true,'Cancel cleanup has not settled');assert.equal(f.controller.pendingSwitch,undefined);assert.equal(f.controller.pendingSwitchOwner,undefined);assert.equal(f.controller.pendingSwitchCancelled,false);assert.throws(()=>owner.pin(),/NATIVE_CONTROL_RELEASED/);
  assert.equal(f.controller.switchRejected,token.sequence);assert.equal(f.controller.switchReason,'cancelled');assert.equal(f.controller.switchRejectedGuards,7);assert.equal(f.controller.switchRejectedBoundary,'cancel-native-end');assert.equal(f.controller.switchRejectedEpoch,token.epoch);assert.equal(f.controller.switchRejectedCurrentEpoch,token.epoch+1);assert.equal(f.controller.switchRejectedGeneration,token.revision);assert.equal(f.controller.switchRejectedCurrentGeneration,token.revision+1);assert.equal(f.controller.switchRejectedTextVersion,token.textRevision);assert.equal(f.controller.switchRejectedCurrentTextVersion,token.textRevision+1);assert.equal(f.controller.switchSettled,0);assert.equal(f.controller.presentation,'anchored');assert.equal(f.controller.switchRequestSequence,token.sequence);assert.equal(f.clears.length,0);assert.deepEqual(f.editor.view.document,accepted);
  const focus=new Element(f.document);focus.focus();
  // These real callbacks can already be queued before disabled controls render.
  // Escape must not start a second Cancel or release the first intent fence.
  for(let n=0;n<2;n++){const escape=new Event('keydown',{cancelable:true});Object.defineProperty(escape,'key',{value:'Escape'});textarea.dispatchEvent(escape);assert.equal(escape.defaultPrevented,true);await settle();assert.equal(f.controller.cancelIntentEpoch,token.epoch);assert.equal(f.controller.cancelDispatchEpoch,token.epoch);}
  await togglePresentation(f);f.click('Apply text');await settle();assert.equal(f.controller.cancelIntentEpoch,token.epoch);assert.equal(f.controller.work,1);assert.equal(f.context.events.filter(value=>value==='realm-release').length,1);assert.equal(f.controller.switchRequestSequence,token.sequence);assert.equal(f.controller.switchSettled,0);assert.equal(f.controller.switchRejected,token.sequence);assert.equal(f.controller.presentation,'anchored');assert.equal(f.document.activeElement,focus);assert.equal(f.context.preparations.length,0);assert.equal(f.clears.length,0);assert.deepEqual(f.editor.view.document,accepted);
 }finally{cleanup.resolve();}
 await until(()=>!f.controller.active&&f.controller.cancelIntentEpoch===undefined,'cancelled text session');await f.controller.memory.drain();assert.equal(f.controller.cancelDispatchEpoch,undefined);assert.equal(f.controller.control,textarea);assert.equal(f.clears.length,1);assert.equal(f.controller.lifecycle.pendingOperations,0);assert.equal(f.controller.lifecycle.controlMemory.actions,0);assert.equal(f.context.held,0);assert.deepEqual(f.editor.view.document,accepted);await f.controller.releaseDocument();released(f.controller);
});

test('Cancel fences queued Switch and Apply throughout held dispatch while Cancel switch only drops presentation',async()=>{
 const f=fixture(),dispatch=deferred();await f.begin();await f.input('pending dispatch',true);await togglePresentation(f);const token=f.controller.pendingSwitch,owner=f.controller.pendingSwitchOwner,accepted=structuredClone(f.editor.view.document),commands=structuredClone(f.commands),original=f.editor.run;assert(owner);let entered=0;
 f.editor.run=async function(label,work){if(label==='Cancel text edit'){entered++;await dispatch.promise;}return original.call(this,label,work);};
 try{
  f.click('Cancel text edit');await settle();f.controller.control.dispatchEvent(new Event('compositionend'));await f.input('pending dispatch');await until(()=>entered===1,'held Cancel dispatcher');
  assert.equal(f.controller.pendingAction,undefined,'settle has handed Cancel to the dispatcher');assert.equal(f.controller.epoch,token.epoch);assert.equal(f.controller.cancelIntentEpoch,token.epoch);assert.equal(f.controller.cancelDispatchEpoch,token.epoch);assert.equal(f.controller.pendingSwitch,token);assert.equal(f.controller.pendingSwitchOwner,owner);assert.equal(f.controller.pendingSwitchCancelled,true);assert.equal(f.controller.work,1);const focus=new Element(f.document);focus.focus();
  // A trailing native final-input settlement must not mistake a dispatched
  // Cancel for an abandoned intent and retire its still-owned presentation.
  const rejected=f.controller.switchRejected,settled=f.controller.switchSettled;await f.input('pending dispatch');await settle();assert.equal(f.controller.pendingSwitch,token);assert.equal(f.controller.pendingSwitchOwner,owner);assert.equal(f.controller.pendingSwitchCancelled,true);assert.equal(f.controller.cancelDispatchEpoch,token.epoch);assert.equal(f.controller.switchRequestSequence,token.sequence);assert.equal(f.controller.switchRejected,rejected);assert.equal(f.controller.switchSettled,settled);assert.equal(f.controller.epoch,token.epoch);assert.equal(f.document.activeElement,focus);
  await togglePresentation(f);f.click('Apply text');await settle();assert.equal(f.controller.switchRequestSequence,token.sequence);assert.equal(f.controller.switchSettled,0);assert.equal(f.controller.presentation,'anchored');assert.equal(f.controller.pendingSwitch,token);assert.equal(f.controller.pendingSwitchOwner,owner);assert.equal(f.document.activeElement,focus);assert.equal(f.clears.length,0);assert.equal(f.context.preparations.length,0);
  f.click('Cancel switch');await settle();assert.equal(f.controller.pendingSwitch,undefined);assert.equal(f.controller.pendingSwitchOwner,undefined);assert.throws(()=>owner.pin(),/NATIVE_CONTROL_RELEASED/);assert.equal(f.controller.switchRejected,token.sequence);assert.equal(f.controller.switchReason,'cancelled');assert.equal(f.controller.active,true);assert.equal(f.controller.cancelIntentEpoch,token.epoch);assert.equal(f.controller.cancelDispatchEpoch,token.epoch);
  await togglePresentation(f);f.click('Apply text');await settle();assert.equal(entered,1);assert.equal(f.controller.switchRequestSequence,token.sequence);assert.equal(f.controller.switchSettled,0);assert.equal(f.controller.presentation,'anchored');assert.equal(f.document.activeElement,focus);assert.equal(f.clears.length,0);assert.deepEqual(f.commands,commands);assert.deepEqual(f.editor.view.document,accepted);
 }finally{dispatch.resolve();f.editor.run=original;}
 await until(()=>!f.controller.active&&f.controller.cancelIntentEpoch===undefined,'original Cancel completes after dispatch');await f.controller.memory.drain();assert.equal(entered,1);assert.equal(f.controller.cancelDispatchEpoch,undefined);assert.equal(f.clears.length,1);assert.equal(f.context.preparations.length,0);assert.equal(f.controller.lifecycle.pendingOperations,0);assert.equal(f.controller.lifecycle.controlMemory.actions,0);assert.deepEqual(f.commands,commands);assert.deepEqual(f.editor.view.document,accepted);await f.controller.releaseDocument();released(f.controller);
});

test('native composition restarting inside held Cancel dispatch preserves the same intent until its next actual end',async()=>{
 const f=fixture(),dispatch=deferred();await f.begin();await f.input('first preedit',true);await togglePresentation(f);const token=f.controller.pendingSwitch,owner=f.controller.pendingSwitchOwner,accepted=structuredClone(f.editor.view.document),original=f.editor.run;assert(owner);let entered=0;
 f.editor.run=async function(label,work){if(label==='Cancel text edit'&&++entered===1)await dispatch.promise;return original.call(this,label,work);};
 try{
  f.click('Cancel text edit');await settle();f.controller.control.dispatchEvent(new Event('compositionend'));await f.input('first preedit');await until(()=>entered===1,'first held Cancel dispatch');assert.equal(f.controller.pendingAction,undefined);
  await f.input('first preedit');await settle();assert.equal(f.controller.pendingSwitch,token);assert.equal(f.controller.pendingSwitchOwner,owner);assert.equal(f.controller.pendingSwitchCancelled,true);assert.equal(f.controller.cancelDispatchEpoch,token.epoch);assert.equal(f.controller.switchRequestSequence,token.sequence);assert.equal(f.controller.switchRejected,0);assert.equal(f.controller.switchSettled,0);assert.equal(f.controller.epoch,token.epoch);assert.equal(f.clears.length,0);
  f.controller.control.dispatchEvent(new Event('compositionstart'));await f.input('restarted preedit',true);assert.equal(f.controller.composing,true);assert.equal(f.controller.pendingSwitch,token);assert.equal(f.controller.pendingSwitchOwner,owner);assert.equal(f.controller.epoch,token.epoch);assert.equal(f.controller.revision,token.revision+1);assert.equal(f.controller.textRevision,token.textRevision+1);
  dispatch.resolve();await until(()=>f.controller.work===0&&f.controller.cancelDispatchEpoch===undefined,'Cancel re-deferred at restarted composition');assert.equal(f.controller.active,true);assert.equal(f.controller.pendingAction,'cancel');assert.equal(f.controller.cancelIntentEpoch,token.epoch);assert.equal(f.controller.pendingSwitchCancelled,true);assert.equal(f.controller.pendingSwitch,token);assert.equal(f.controller.pendingSwitchOwner,owner);assert.equal(f.controller.switchRejected,0);assert.equal(f.controller.switchSettled,0);assert.equal(f.clears.length,0);
  const focus=new Element(f.document);focus.focus();f.document.dispatchEvent(new Event('focusin'));await togglePresentation(f);f.click('Apply text');await settle();assert.equal(f.controller.pendingAction,'cancel');assert.equal(f.controller.switchRequestSequence,token.sequence);assert.equal(f.controller.presentation,'anchored');assert.equal(f.document.activeElement,focus);assert.deepEqual(f.editor.view.document,accepted);
  f.controller.control.dispatchEvent(new Event('compositionend'));await f.input('restarted preedit');await until(()=>!f.controller.active&&f.controller.cancelIntentEpoch===undefined,'one Cancel after the next native end');assert.equal(entered,2);assert.equal(f.controller.switchRejected,token.sequence);assert.equal(f.controller.switchReason,'cancelled');assert.equal(f.controller.switchRejectedBoundary,'cancel-native-end');assert.equal(f.controller.switchRejectedGuards,7);assert.equal(f.controller.pendingSwitchOwner,undefined);assert.throws(()=>owner.pin(),/NATIVE_CONTROL_RELEASED/);assert.equal(f.controller.switchRequestSequence,token.sequence);assert.equal(f.controller.switchSettled,0);assert.equal(f.clears.length,1);assert.equal(f.context.preparations.length,0);assert.equal(f.document.activeElement,focus,'Re-dispatched Cancel retains the original focus intent');assert.equal(f.controller.cancelFocusEpoch,undefined);assert.deepEqual(f.editor.view.document,accepted);
 }finally{dispatch.resolve();f.editor.run=original;await Promise.allSettled([...f.controller.pending]);}
 await f.controller.releaseDocument();released(f.controller);assert.equal(f.controller.lifecycle.controlMemory.actions,0);
});

test('unavailable native composition end drops its real Cancel-owned presentation without a successful witness',async()=>{
 const f=fixture();await f.begin();await f.input('unavailable preedit',true);await togglePresentation(f);const token=f.controller.pendingSwitch,owner=f.controller.pendingSwitchOwner,accepted=structuredClone(f.editor.view.document),saved=structuredClone([...f.drafts]);assert(owner);f.click('Cancel text edit');await settle();const focus=new Element(f.document);focus.focus();
 // Isolate the existing availability guard; this is controller fault injection,
 // not a claim of inducing a real stream-cleanup failure or platform IME event.
 const marker=Error('ISOLATED_UNAVAILABLE_NATIVE_END');f.controller.readCleanupErrors.add(marker);
 try{
  f.controller.control.dispatchEvent(new Event('compositionend'));await flush();assert.equal(f.controller.active,true);assert.equal(f.controller.pendingSwitch,undefined);assert.equal(f.controller.pendingSwitchOwner,undefined);assert.equal(f.controller.pendingSwitchCancelled,false);assert.equal(f.controller.pendingAction,undefined);assert.equal(f.controller.cancelIntentEpoch,undefined);assert.equal(f.controller.cancelDispatchEpoch,undefined);assert.throws(()=>owner.pin(),/NATIVE_CONTROL_RELEASED/);assert.equal(f.controller.switchRejected,token.sequence);assert.equal(f.controller.switchReason,'cancelled');assert.equal(f.controller.switchRejectedBoundary,'cancel-unavailable');assert.equal(f.controller.switchRejectedGuards,0);assert.equal(f.controller.switchRequestSequence,token.sequence);assert.equal(f.controller.switchSettled,0);assert.equal(f.controller.presentation,'anchored');assert.equal(f.document.activeElement,focus);assert.equal(f.clears.length,0);assert.deepEqual([...f.drafts],saved);assert.deepEqual(f.editor.view.document,accepted);
 }finally{f.controller.readCleanupErrors.delete(marker);}
 await f.controller.releaseDocument();released(f.controller);assert.equal(f.controller.lifecycle.controlMemory.actions,0);
});

test('release discards a Cancel-owned deferred presentation without applying it to the next session',async()=>{
 const f=fixture();await f.begin();await f.input('uncommitted composition',true);await togglePresentation(f);const token={...f.controller.pendingSwitch},owner=f.controller.pendingSwitchOwner;assert(owner);f.click('Cancel text edit');await settle();assert.equal(f.controller.pendingSwitchCancelled,true);const saved=structuredClone([...f.drafts]);
 await f.controller.releaseDocument();released(f.controller);assert.equal(f.controller.pendingSwitch,undefined);assert.equal(f.controller.pendingSwitchOwner,undefined);assert.equal(f.controller.pendingSwitchCancelled,false);assert.equal(f.controller.cancelIntentEpoch,undefined);assert.equal(f.controller.cancelDispatchEpoch,undefined);assert.throws(()=>owner.pin(),/NATIVE_CONTROL_RELEASED/);assert.equal(f.controller.switchRejected,token.sequence);assert.equal(f.controller.switchReason,'stale-session');assert(f.controller.switchRejectedGuards&1);assert.equal(f.controller.switchSettled,0);assert.deepEqual(f.clears,[]);assert.deepEqual([...f.drafts],saved);
 f.editor.view.document={id:'document-b',revision:'1',width:32,height:32};await f.begin();assert.equal(f.controller.presentation,'anchored');assert.equal(f.controller.pendingSwitch,undefined);assert.equal(f.controller.switchSettled,0);
});

test('explicit composition Cancel keeps priority over a later Apply intent',async()=>{
 const f=fixture();await f.begin();await f.input('pending preedit',true);await togglePresentation(f);const pending=f.controller.pendingSwitch,owner=f.controller.pendingSwitchOwner,accepted=structuredClone(f.editor.view.document),commands=structuredClone(f.commands);assert(owner);
 f.click('Cancel text edit');await settle();f.click('Apply text');await settle();assert.equal(f.controller.pendingAction,'cancel');assert.equal(f.controller.pendingSwitchCancelled,true);assert.equal(f.controller.pendingSwitch,pending);assert.equal(f.controller.pendingSwitchOwner,owner);assert.equal(f.controller.switchSettled,0);assert.equal(f.controller.active,true);
 f.controller.control.dispatchEvent(new Event('compositionend'));await f.input('pending preedit');await until(()=>!f.controller.active,'Cancel rather than Apply');assert.equal(f.controller.switchReason,'cancelled');assert.equal(f.controller.switchRejected,pending.sequence);assert.equal(f.controller.switchRejectedBoundary,'cancel-native-end');assert.equal(f.controller.switchRejectedGuards,1,'No text changed in this separate priority case');assert.equal(f.controller.switchSettled,0);assert.equal(f.controller.pendingSwitchOwner,undefined);assert.throws(()=>owner.pin(),/NATIVE_CONTROL_RELEASED/);assert.equal(f.clears.length,1);assert.equal(f.context.preparations.length,0);assert.deepEqual(f.commands,commands);assert.deepEqual(f.editor.view.document,accepted);
});

for(const failure of ['save refusal','busy dispatcher'])test('Cancel-owned presentation never revives after '+failure,async()=>{
 const f=fixture(),held=deferred();await f.begin();await f.input('pending cancellation',true);await togglePresentation(f);const token={...f.controller.pendingSwitch},owner=f.controller.pendingSwitchOwner,accepted=structuredClone(f.editor.view.document);assert(owner);f.click('Cancel text edit');await settle();assert.equal(f.controller.pendingSwitchCancelled,true);
 const original=f.editor.changeDraft;let busy;
 try{
  if(failure==='save refusal')f.editor.changeDraft=()=>{throw Error('ISOLATED_DRAFT_SAVE_FAILURE');};
  else{busy=f.controller.run('Isolated pending native action',()=>held.promise);await flush();assert.equal(f.controller.work,1);}
  f.controller.control.dispatchEvent(new Event('compositionend'));await f.input('pending cancellation');await until(()=>f.controller.pendingSwitchOwner===undefined,'discarded Cancel-owned intent');
  assert.equal(f.controller.active,true);assert.equal(f.controller.pendingSwitch,undefined);assert.equal(f.controller.pendingSwitchCancelled,false);assert.throws(()=>owner.pin(),/NATIVE_CONTROL_RELEASED/);assert.equal(f.controller.switchRejected,token.sequence);assert.equal(f.controller.switchReason,'cancelled');assert.equal(f.controller.switchRejectedBoundary,failure==='save refusal'?'cancel-save-refused':'cancel-not-retired');assert.equal(f.controller.switchSettled,0);assert.equal(f.controller.presentation,'anchored');assert.equal(f.clears.length,0);assert.deepEqual(f.editor.view.document,accepted);
  assert.equal(f.controller.cancelDispatchEpoch,undefined);assert.equal(f.controller.cancelIntentEpoch,failure==='save refusal'?token.epoch:undefined);assert.equal(f.controller.pendingAction,failure==='save refusal'?'cancel':undefined);
 }finally{f.editor.changeDraft=original;held.resolve();await busy;}
 // Subsequent ordinary input/save may finish Cancel, but the old presentation
 // request can never be replayed, re-owned, or report a successful settlement.
 await f.input('pending cancellation');await until(()=>f.controller.cancelIntentEpoch===undefined,'Cancel intent resolved after retry');assert.equal(f.controller.cancelDispatchEpoch,undefined);assert.equal(f.controller.pendingSwitch,undefined);assert.equal(f.controller.pendingSwitchOwner,undefined);assert.equal(f.controller.switchSettled,0);assert.equal(f.controller.presentation,'anchored');assert.equal(f.controller.switchRequestSequence,token.sequence);await f.controller.releaseDocument();released(f.controller);assert.equal(f.controller.lifecycle.controlMemory.actions,0);
});

for(const cause of ['refused input','unobserved native value'])test('pending focus restoration vetoes '+cause+' even with unchanged generation and text counters',async()=>{
 const f=fixture();await f.begin();await f.input('Retained text');const textarea=f.controller.control,epoch=f.controller.epoch,revision=f.controller.revision,textRevision=f.controller.textRevision,accepted=structuredClone(f.editor.view.document),raf=globalThis.requestAnimationFrame,caf=globalThis.cancelAnimationFrame;let frame,work,pressure;
 try{
  globalThis.requestAnimationFrame=callback=>{frame=callback;return 991;};globalThis.cancelAnimationFrame=id=>{assert.equal(id,991);frame=undefined;};work=f.controller.switchTo('inspector');await flush();assert.equal(typeof frame,'function');
  const other=new Element(f.document);other.focus();textarea.scrollTop=111;textarea.scrollLeft=23;
  if(cause==='refused input'){pressure=promptPressure();await f.input('Refused raw native value');assert.equal(f.controller.lifecycle.nativeInputRefused,true);pressure.release();pressure=undefined;}
  else textarea.value='Raw native value before its input event';
  assert.equal(f.controller.epoch,epoch);assert.equal(f.controller.revision,revision);assert.equal(f.controller.textRevision,textRevision);assert.notEqual(textarea.value,f.controller.session.text);
  const callback=frame;frame=undefined;callback();await work;assert.equal(f.document.activeElement,other,'Old presentation cannot steal focus');assert.equal(textarea.scrollTop,111);assert.equal(textarea.scrollLeft,23);assert.equal(f.controller.lifecycle.pendingOperations,0);assert.equal(f.controller.lifecycle.controlMemory.actions,0);assert.deepEqual(f.editor.view.document,accepted);
 }finally{pressure?.release();if(frame){const callback=frame;frame=undefined;callback();}await work;globalThis.requestAnimationFrame=raf;globalThis.cancelAnimationFrame=caf;}
});

test('an old rendered presentation action is rejected after another native session opens',async()=>{
 const f=fixture();await f.begin();const old=presentationButton(f.template()),epoch=f.controller.epoch;assert(old);await f.controller.releaseDocument();f.editor.view.document={id:'document-b',revision:'1',width:32,height:32};await f.begin();old.callback(event());await settle();assert.equal(f.controller.presentation,'anchored');assert.equal(f.controller.switchSettled,0);assert.equal(f.controller.switchReason,'stale-session');assert.equal(f.controller.switchRejectedEpoch,epoch);assert.equal(f.controller.switchRejectedCurrentEpoch,f.controller.epoch);assert.equal(f.controller.switchRequestSequence,1);
});

// Native-control allocation successors exercise the real capture listeners,
// EditingController and DraftPersistence close barrier. Font/raster work remains
// the explicit stand-in above; this does not assert browser IME platform behavior.
function promptPressure(){return allocationLedger.reserve({owner:'native-input-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes});}
function actualDraftOwner(f){
 const owner=new DraftPersistence(f.editor.sessionId,async()=>{throw Error('unexpected draft transport');},()=>''),original=f.editor.changeDraft;
 f.editor.draftOwner=owner;f.editor.registerDraft=(id,documentId)=>owner.registerDraft(id,documentId);
 f.editor.changeDraft=function(id,kind,text,targetLayerId,composing,revision){
  owner.change({id,kind,text,documentId:this.view.document.id,targetLayerId,composing,expectedDocumentRevision:revision});const draft=owner.drafts.get(id);draft.savedGeneration=draft.generation;
  f.changes.push({id,kind,value:text,target:targetLayerId,composing,revision});
 };
 return owner;
}
test('refused native input stays visible through host updates, never enters JS draft state, and blocks real Close until correction',async()=>{
 const f=fixture(),owner=actualDraftOwner(f);try{await f.begin();await f.input('Accepted text');const session=f.controller.session,id=session.draftId,saved=owner.drafts.get(id).text,pressure=promptPressure();
  try{await f.input('Full refused native input');assert.equal(f.controller.session,session);assert.equal(f.controller.model.draft.get(),'Accepted text');assert.equal(owner.drafts.get(id).text,saved);assert.equal(f.controller.control.value,'Full refused native input');assert.equal(f.controller.lifecycle.nativeInputRefused,true);assert.equal(f.controller.lifecycle.unadmittedNativeUnits,'Full refused native input'.length);f.host.requestUpdate();await settle();assert.equal(f.controller.control.value,'Full refused native input');assert.throws(()=>owner.assertDocumentSaved('document-a'),/workspace is full/);}finally{pressure.release();}
  await f.input('Accepted text');assert.equal(f.controller.lifecycle.nativeInputRefused,false);assert.equal(f.controller.lifecycle.unadmittedNativeUnits,0);assert.equal(f.controller.model.draft.get(),'Accepted text');assert.doesNotThrow(()=>owner.assertDocumentSaved('document-a'));
 }finally{await f.controller.releaseDocument();owner.dispose();}
});
test('refused native composition cannot leak its full raw value into bridge orphan cleanup',async()=>{
 const f=fixture(),owner=actualDraftOwner(f);try{await f.begin();await f.input('Accepted');f.controller.control.dispatchEvent(new Event('compositionstart'));await f.input('Accepted IME',true);const admitted=f.controller.model.draft.get(),pressure=promptPressure();
  try{await f.input('Unadmitted composition',true);assert.equal(f.controller.model.draft.get(),admitted);assert.equal(f.controller.composing,true);f.controller.control.dispatchEvent(new Event('compositionend'));await settle();assert.equal(f.controller.composing,false);assert.equal(f.controller.control.value,'Unadmitted composition');assert.equal(f.controller.model.draft.get(),admitted);assert.throws(()=>owner.assertDocumentSaved('document-a'),/workspace is full/);f.controller.bridge.hostDisconnected();assert.equal(f.controller.model.draft.get(),admitted);}finally{pressure.release();}
 }finally{await f.controller.releaseDocument();owner.dispose();}
});
test('native typing beyond renderer text size stays complete in the recoverable draft without starting raster work',async()=>{
 const f=fixture();await f.begin();const value='n'.repeat(16385);await f.input(value);assert.equal(f.controller.session.text,value);assert.equal(f.controller.model.draft.get(),value);assert.equal(f.controller.control.value,value);assert.equal(JSON.parse(f.changes.at(-1).value).text,value);assert.equal(f.context.renderers.length,0);assert.equal(f.controller.lifecycle.nativeInputRefused,false);
});
test('a native change without a preceding input adopts the same admitted complete draft',async()=>{
 const f=fixture();await f.begin();f.controller.control.value='Changed through native autofill';f.controller.control.dispatchEvent(new Event('change'));await settle();assert.equal(f.controller.session.text,'Changed through native autofill');assert.equal(f.controller.model.draft.get(),'Changed through native autofill');assert.equal(JSON.parse(f.changes.at(-1).value).text,'Changed through native autofill');
});
test('structured control refusal restores actual host value and leaves the entire accepted session intact',async()=>{
 const f=fixture();await f.begin();await f.input('Keep text');const session=f.controller.session,saved=f.changes.length,pressure=promptPressure();let target;
 try{target=f.field('<en-number-field',{value:'999'});await settle();assert.equal(f.controller.session,session);assert.equal(target.value,'0');assert.deepEqual(f.controller.session.placement,{x:0,y:0});assert.equal(f.changes.length,saved);}finally{pressure.release();}
 target.value='12';const e=event(target);f.controller.mutate(e,s=>{s.placement={...s.placement,x:Number(target.value)};},f.controller.epoch,'New text X (document px)');e.currentTarget=null;await settle();assert.equal(f.controller.session.placement.x,12,'settled callback uses captured host after real dispatch clears currentTarget');
});
test('rejected file selection restores the actual public files property without materializing file bytes',async()=>{
 const f=fixture();await f.begin();const old=new File(['small'],'old.ttf');f.field('<en-file-upload label="Font file"',{files:[old]});await settle();let materialized=0;const next=new File(['replacement'],'new.ttf');next.arrayBuffer=async()=>{materialized++;throw Error('must not read');};const pressure=promptPressure();
 try{const target=f.field('<en-file-upload label="Font file"',{files:[next]});await settle();assert.deepEqual(target.files,[old]);assert.deepEqual(f.controller.files,[old]);assert.equal(materialized,0);}finally{pressure.release();}
});
test('draft serialization admission fails before stringify and leaves prior saved delivery intact',async()=>{
 const f=fixture(),owner=actualDraftOwner(f);try{await f.begin();await f.input('Retain exact draft');const previous=owner.drafts.get(f.controller.session.draftId).text,pressure=promptPressure(),stringify=JSON.stringify;let calls=0;
  try{JSON.stringify=function(...args){calls++;return stringify.apply(this,args);};assert.throws(()=>f.controller.save(false),/PROMPT_MEMORY_BUDGET/);assert.equal(calls,0);assert.equal(owner.drafts.get(f.controller.session.draftId).text,previous);assert.equal(owner.hasRefusedChanges,true);}finally{JSON.stringify=stringify;pressure.release();}
  f.controller.save(false);assert.equal(owner.hasRefusedChanges,false);
 }finally{await f.controller.releaseDocument();owner.dispose();}
});
test('candidate JSON parser admission precedes Blob decoding and rejected admission cannot stage bytes',async()=>{
 const f=fixture();await f.begin();let decoded=0;const blob=new Blob(['{"source":{"render":{}}}'],{type:'application/json'});blob.text=async()=>{decoded++;throw Error('must not decode');};const before=f.stages.length,pressure=promptPressure();
 try{await assert.rejects(f.controller.storage.stage(blob,'application/json'),/PROMPT_MEMORY_BUDGET/);assert.equal(decoded,0);assert.equal(f.stages.length,before);}finally{pressure.release();}
});
test('a late renderer request owns its immutable text generation after newer input supersedes it',async()=>{
 const f=fixture(),gate=deferred();await f.begin();await f.input('Old exact request');let request;
 f.context.render=async value=>{request=value;return gate.promise;};f.click('Preview text');await until(()=>!!request,'held request');const models=f.controller.lifecycle.controlMemory.models;await f.input('New independent request');assert.equal(request.text,'Old exact request');assert.equal(f.controller.session.text,'New independent request');assert(f.controller.lifecycle.controlMemory.models>=models,'request and its pinned prior session remain owned');
 gate.resolve({rgba:new Blob([new Uint8Array([1,2,3,255])]),rasterHash:hash('late'),overflow:false,width:1,height:1});await until(()=>f.controller.lifecycle.pendingOperations===0,'late request drain');assert.equal(f.controller.lifecycle.previewBytes,0);assert.equal(f.controller.session.text,'New independent request');
});
test('bounded native missing-glyph diagnostics keep codepoints useful and reject oversized details',async()=>{
 const f=fixture();await f.begin();const {TextFailure}=await import(contracts);assert.match(f.controller.diagnostic(new TextFailure('TEXT_MISSING_GLYPHS',{codepoints:[65,0x6771]})),/U\+41, U\+6771/);assert.equal(f.controller.diagnostic(new TextFailure('TEXT_MISSING_GLYPHS',{codepoints:Array(257).fill(65)})),'Missing glyphs in selected fonts. Full text and accepted appearance are retained.');assert.equal(f.controller.diagnostic(new TextFailure('X'.repeat(129))),'Text operation returned an unsupported diagnostic. Full text is retained.');
});
test('document release cancels a retained presentation frame and drains its action owner',async()=>{
 const f=fixture();await f.begin();const raf=globalThis.requestAnimationFrame,caf=globalThis.cancelAnimationFrame;let callback,canceled=0;
 try{globalThis.requestAnimationFrame=work=>{callback=work;return 987;};globalThis.cancelAnimationFrame=id=>{assert.equal(id,987);canceled++;callback=undefined;};f.controller.switchTo('inspector');await flush();assert.equal(typeof callback,'function');assert(f.controller.lifecycle.controlMemory.actions>0);await f.controller.releaseDocument();assert.equal(canceled,1);assert.equal(callback,undefined);assert.equal(f.controller.lifecycle.controlMemory.actions,0);assert.equal(f.controller.lifecycle.pendingOperations,0);}finally{globalThis.requestAnimationFrame=raf;globalThis.cancelAnimationFrame=caf;}
});
test('typed descriptor cleanup failure stays owned and prevents reopen until real unlock retry succeeds',async()=>{
 const f=fixture();let unlocked=false,attempts=0;const raw=JSON.stringify({value:'bounded descriptor'}),response=new Response(raw,{headers:{'content-length':String(Buffer.byteLength(raw))}}),reader=response.body.getReader();response.body.getReader=()=>({read:()=>reader.read(),cancel:()=>reader.cancel(),get closed(){return reader.closed;},releaseLock(){attempts++;if(!unlocked)throw Error('temporary unlock failure');reader.releaseLock();}});
 f.editor.ownedJSON=(path,owner,init,owns,maxBytes,kind)=>readOwnedJSON(async()=>response,path,{owner,init,owns,maxBytes,kind});await assert.rejects(f.controller.readControl('/descriptor'),/PROMPT_READER_CLEANUP_FAILED/);assert.equal(f.controller.controlCleanup.size,1);assert.equal(response.body.locked,true);await f.controller.begin(new Element(f.document));assert.equal(f.controller.active,false);
 unlocked=true;await f.controller.releaseDocument();assert(attempts>=3);assert.equal(response.body.locked,false);assert.equal(f.controller.controlCleanup.size,0);assert.equal(allocations().activeRecords,0);
});
test('nested native input notification keeps the newer admitted generation instead of replaying the outer draft',async()=>{
 const f=fixture();await f.begin();let nested=false;f.host.addEventListener('en-input',event=>{if(nested||event.detail.value!=='Outer')return;nested=true;f.controller.control.value='Newer nested text';const input=new Event('input');Object.defineProperty(input,'isComposing',{value:false});f.controller.control.dispatchEvent(input);});
 await f.input('Outer');assert.equal(f.controller.session.text,'Newer nested text');assert.equal(f.controller.model.draft.get(),'Newer nested text');assert.equal(f.controller.control.value,'Newer nested text');assert.equal(JSON.parse(f.changes.at(-1).value).text,'Newer nested text');assert.equal(f.changes.some(change=>JSON.parse(change.value).text==='Outer'),false);
});
test('composition-end alias growth is admitted before the bridge accepts its native commit',async()=>{
 const f=fixture(),owner=actualDraftOwner(f);try{await f.begin();f.controller.control.dispatchEvent(new Event('compositionstart'));await f.input('composition',true);const session=f.controller.session,pressure=allocationLedger.reserve({owner:'native-composition-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes-1});
  try{f.controller.control.dispatchEvent(new Event('compositionend'));await settle();assert.equal(f.controller.session,session);assert.equal(f.controller.control.value,'composition');assert.equal(f.controller.compositionUnits,0,'bridge commit alias was never authorized');assert.equal(f.controller.lifecycle.nativeInputRefused,true);assert.throws(()=>owner.assertDocumentSaved('document-a'),/workspace is full/);}finally{pressure.release();}
  await f.input('composition');assert.equal(owner.hasRefusedChanges,false);assert.equal(f.controller.composing,false);
 }finally{await f.controller.releaseDocument();owner.dispose();}
});

// Owned response caller seams: these wrappers use actual model leases around
// deterministic client facts. EditorClient's wire/recovery engine is tested in
// its own suite; no raw-return compatibility API is exercised by these callers.
test('imported FontVersion has independent ownership after the scoped command result releases',async()=>{
 const f=fixture({native:false}),library=f.library(),before=allocations();const imported=await library.import(new Blob([fontBytes]),new Blob([licenseText]),'local-file');
 let release;try{assert.deepEqual(imported.value,font);assert.notEqual(imported.value,font);assert.equal(allocations().activeRecords,before.activeRecords+1);assert.equal(f.context.held,0);release=imported.pin();imported.release();assert.equal(allocations().activeRecords,before.activeRecords+1);release();assert.deepEqual(allocations(),before);}finally{imported.release();release?.();}
});
test('owned font inputs keep actual Blob backing charged after library clear until the final consumer releases',async()=>{
 const f=fixture({native:false}),library=f.library(),loaded=await library.load([font]),unpin=loaded.pin();try{loaded.release();library.clear();assert.equal(library.lifecycle.retainedFontBytes,0);assert.equal(f.context.held,fontBytes.length,'the outstanding returned input owns the actual backing');assert.equal(loaded.value[0].bytes.size,fontBytes.length);unpin();assert.equal(f.context.held,0);assert.throws(()=>loaded.pin(),/FONT_INPUT_RELEASED/);assert.equal(allocations().activeRecords,0);}finally{loaded.release();unpin();}
});
test('font status retains its exact owned metadata through the final HEAD completion after Close',async()=>{
 const f=fixture(),gate=deferred();let received=0,released=0;const own=f.editor.ownedFontAssets;
 try{f.editor.ownedFontAssets=async function(...args){const owner=await own.apply(this,args);received++;return {...owner,release(){released++;owner.release();}};};f.editor.session.transport=()=>gate.promise;await f.begin();assert.equal(received,1);assert.equal(released,0);let done=false;const closing=f.controller.releaseDocument().then(()=>{done=true;});await flush();assert.equal(done,false);assert.equal(released,0);gate.resolve({ok:true});await closing;assert.equal(released,1);}finally{gate.resolve({ok:true});}
});
test('staged BlobRef owners survive a pending native consumer and release only after actual Close drain',async()=>{
 const f=fixture(),gate=deferred();try{await f.begin();let reference;const work=f.controller.run('Retained staged result',async()=>{reference=await f.controller.storage.stage(new Blob(['payload']),'text/plain');await gate.promise;assert.equal(reference.hash,hash('payload'));});await until(()=>!!reference,'owned stage result');assert.equal(f.controller.stageOwners.size,1);let done=false;const closing=f.controller.releaseDocument().then(()=>{done=true;});await flush();assert.equal(done,false);assert.equal(f.controller.stageOwners.size,1);gate.resolve();await Promise.all([work,closing]);assert.equal(f.controller.stageOwners.size,0);assert.equal(allocations().activeRecords,0);}finally{gate.resolve();}
});
test('native storage caps retained staged references before starting the next upload',async()=>{
 const f=fixture();await f.begin();const before=f.stages.length;for(let i=0;i<16;i++)await f.controller.storage.stage(new Blob(['payload']),'text/plain');assert.equal(f.controller.stageOwners.size,16);await assert.rejects(f.controller.storage.stage(new Blob(['seventeenth']),'text/plain'),/TEXT_STAGE_REFERENCES/);assert.equal(f.stages.length,before+16);await f.controller.releaseDocument();assert.equal(f.controller.stageOwners.size,0);
});
test('late owned staging completion after Close is released without crossing the storage adapter',async()=>{
 const f=fixture(),gate=deferred();try{await f.begin();let released=0;f.editor.ownedStageTextBlob=async()=>{await gate.promise;const result=cloneOwnedModel('fixture-late-ref',{hash:hash('late'),byteLength:'4',mediaType:'text/plain'});return {...result,release(){released++;result.release();}};};
 const work=f.controller.run('Late staged reference',async()=>{await f.controller.storage.stage(new Blob(['late']),'text/plain');assert.fail('stale reference escaped');});await flush();const closing=f.controller.releaseDocument();await flush();gate.resolve();await Promise.all([work,closing]);assert.equal(released,1);assert.equal(f.controller.stageOwners.size,0);assert.equal(allocations().activeRecords,0);}finally{gate.resolve();}
});
test('native Apply consumes command facts only while the scoped result owner is live',async()=>{
 const f=fixture();await f.begin();await f.input('Scoped Apply');let inScope=false,selected=0;const scoped=f.editor.withCommandEvents;
 f.editor.withCommandEvents=function(body,work,...args){return scoped.call(this,body,async facts=>{inScope=true;try{return await work(facts);}finally{inScope=false;}},...args);};f.editor.select=()=>{assert.equal(inScope,true);selected++;};
 f.context.prepare=async(_request,_fonts,storage)=>{const candidate=await storage.stage(new Blob([JSON.stringify({source:{render:{pixels:{hash:hash('raster-preview')}}}})]),'application/json');return {candidate,admissionId:'admission',dependencyHash:hash('dependencies')};};
 f.click('Preview text');await until(()=>f.controller.lifecycle.previewBytes===4,'scoped preview');f.click('Apply text');await until(()=>!f.controller.active&&f.controller.lifecycle.pendingOperations===0,'scoped Apply completion');assert.equal(selected,1);assert.equal(f.controller.stageOwners.size,0);assert.equal(inScope,false);
});
test('native admission acknowledgement is scoped and leaves no retained JSON result',async()=>{
 const f=fixture();await f.begin();await until(()=>f.controller.lifecycle.pendingOperations===0,'background status');const before=allocations();f.editor.json=async(path,init)=>{f.reads.push({path,options:init});return {admitted:true};};await f.controller.admission('local_admission');assert.deepEqual(allocations(),before);const call=f.reads.at(-1);assert.equal(call.path,'/api/v1/text-admission/local_admission');assert.equal(call.options.method,'POST');assert.equal(call.options.body,'{"protocolVersion":1}');
});

test('a retained request keeps its font backing after library clear until its final consumer unpins',async()=>{
 const f=fixture();await f.begin();const request=await f.controller.request(),unpin=request.pin();try{f.controller.library.clear();assert.equal(f.controller.library.lifecycle.retainedFontBytes,0);assert.equal(f.context.held,fontBytes.length);assert.equal(request.value.fonts[0].bytes.size,fontBytes.length);request.release();assert.equal(f.context.held,fontBytes.length);unpin();assert.equal(f.context.held,0);assert.throws(()=>request.pin(),/NATIVE_TEXT_REQUEST_RELEASED/);}finally{request.release();unpin();}
});
test('Apply releases its final request backing after consumers end and before delayed realm shutdown',async()=>{
 const f=fixture(),gate=deferred();await f.begin();await f.input('Scoped final backing');let calls=0;f.context.releaseRealm=async()=>{if(++calls===2){assert.equal(f.context.activeRenderers,0);assert.equal(f.context.activePreparations,0);assert.equal(f.context.held,0);await gate.promise;}};
 f.context.prepare=async(_request,_fonts,storage)=>{assert.equal(f.context.held,fontBytes.length);const candidate=await storage.stage(new Blob([JSON.stringify({source:{render:{pixels:{hash:hash('raster-preview')}}}})]),'application/json');return {candidate,admissionId:'admission',dependencyHash:hash('dependencies')};};
 try{f.click('Preview text');await until(()=>f.controller.lifecycle.previewBytes===4,'realm preview');f.click('Apply text');await until(()=>calls===2,'delayed final realm release');assert.equal(f.controller.active,false);assert(f.controller.lifecycle.pendingOperations>0);assert.equal(f.context.held,0);gate.resolve();await until(()=>f.controller.lifecycle.pendingOperations===0,'realm drain');assert.equal(f.errors.length,0);}finally{gate.resolve();}
});

test('first native input refusal has a preadmitted identity and blocks Close before any draft row exists',async()=>{
 const f=fixture(),owner=actualDraftOwner(f);let pressure;try{await f.begin();assert.equal(owner.drafts.size,0);assert.equal(owner.metadataOwnership.identities,1);pressure=promptPressure();await f.input('First complete refused input');assert.equal(owner.drafts.size,0);assert.equal(owner.hasRefusedChanges,true);assert.equal(f.controller.control.value,'First complete refused input');assert.throws(()=>owner.assertDocumentSaved('document-a'),/workspace is full/);pressure.release();pressure=undefined;await f.input('Recoverable first input');assert.equal(owner.hasRefusedChanges,false);assert.doesNotThrow(()=>owner.assertDocumentSaved('document-a'));}finally{pressure?.release();await f.controller.releaseDocument();await owner.dispose();}
});
test('canceling blank native owners releases registrations after the real render retirement instead of filling a history arena',async()=>{
 const f=fixture(),owner=actualDraftOwner(f);try{for(let n=0;n<70;n++){await f.begin();assert.equal(owner.metadataOwnership.identities,1);assert.equal(owner.drafts.size,0);await f.controller.cancel();await f.controller.memory.drain();await flush();assert.equal(owner.metadataOwnership.identities,0);assert.equal(owner.metadataOwnership.editableBorrowers,0);}}finally{await f.controller.releaseDocument();await owner.dispose();}
});


// Accepted sources keep the durable text limit; over-limit saved drafts remain
// recoverable within the separate bounded read workspace. These calls use the
// actual NativeTextEditing reader and NativeControlMemory/AllocationLedger.
test('accepted text source above 16384 bytes refuses before transport or allocation',async()=>{
 const f=fixture();await settle();const before=allocations(),models=f.controller.lifecycle.controlMemory.models;let reads=0;
 f.editor.session.transport=async()=>{reads++;throw Error('Rejected accepted source must not fetch');};
 await assert.rejects(f.controller.readText('/source?layer=one',{byteLength:'16385',hash:hash('unread accepted source'),mediaType:'text/plain'}),error=>error instanceof Error&&error.message==='TEXT_BYTES');
 assert.equal(reads,0);assert.equal(f.context.held,0);assert.deepEqual(allocations(),before);assert.equal(f.controller.lifecycle.controlMemory.models,models);assert.deepEqual(f.changes,[]);assert.deepEqual(f.commands,[]);
});

test('explicit 70003-byte saved draft returns exact owned text until its final consumer releases',async()=>{
 const f=fixture();await settle();const text='\ufeff'+'x'.repeat(70000),byteLength=Buffer.byteLength(text),before=allocations(),models=f.controller.lifecycle.controlMemory.models;assert.equal(byteLength,70003);
 const response=new Response(text,{headers:{'Content-Length':String(byteLength)}});let reads=0;
 f.editor.session.transport=async(path,options)=>{reads++;assert.equal(path,'/draft?generation=7&content=1');assert(options.signal instanceof AbortSignal);return response;};
 const decoded=await f.controller.readText('/draft?generation=7',{byteLength:String(byteLength),hash:hash(text),mediaType:'text/plain'},'draft');let unpin;
 try{
  assert.equal(reads,1);assert.equal(decoded.value,text,'recovery preserves the leading BOM and every over-limit character');assert.equal(response.body.locked,false);assert.equal(f.context.held,0,'streaming workspace releases after decoding');
  assert.equal(allocations().cpuBytes,before.cpuBytes+text.length*2);assert.equal(allocations().handles,before.handles+1);assert.equal(allocations().activeRecords,before.activeRecords+1);assert.equal(f.controller.lifecycle.controlMemory.models,models+1);
  unpin=decoded.pin();decoded.release();assert.equal(decoded.value,text);assert.equal(allocations().cpuBytes,before.cpuBytes+text.length*2,'the remaining consumer still owns the exact decoded text');assert.equal(f.controller.lifecycle.controlMemory.models,models+1);
  unpin();assert.deepEqual(allocations(),before);assert.equal(f.controller.lifecycle.controlMemory.models,models);assert.throws(()=>decoded.pin(),/NATIVE_CONTROL_RELEASED/);assert.deepEqual(f.changes,[]);assert.deepEqual(f.commands,[]);
 }finally{decoded.release();unpin?.();}
});

test('saved draft above the separate 16 MiB read ceiling refuses before transport or allocation',async()=>{
 const f=fixture();await settle();const before=allocations(),models=f.controller.lifecycle.controlMemory.models;let reads=0;
 f.editor.session.transport=async()=>{reads++;throw Error('Rejected saved draft must not fetch');};
 await assert.rejects(f.controller.readText('/draft?generation=8',{byteLength:String(16*1024**2+1),hash:hash('unread saved draft'),mediaType:'text/plain'},'draft'),error=>error instanceof Error&&error.message==='TEXT_BYTES');
 assert.equal(reads,0);assert.equal(f.context.held,0);assert.deepEqual(allocations(),before);assert.equal(f.controller.lifecycle.controlMemory.models,models);assert.deepEqual(f.changes,[]);assert.deepEqual(f.commands,[]);
});


// Opt-in DOM/dispatcher seam: actual NativeTextEditing actions still own the
// session, draft, render pins and cleanup. This models EditorClient.run's busy
// admission/finally and EnButton's disabled native focus delegation, not paint.
function retirementFocusFixture(){
 const shell=deferred(),buttonUpdate=deferred(),updates=[],runs=[],attempts=[],transitions=[],labels=[];let f,armed=false,external=false,shellHeld=false,buttonHeld=false,componentRevision=0,focused=0,inspectorFocused=0;
 const opener=new Element(),nativeButton=new Element();opener.disabled=false;nativeButton.disabled=false;opener.updateComplete=Promise.resolve();opener.shadowRoot={activeElement:null};
 const retain=promise=>{updates.push(promise);void promise.catch(()=>{});return promise;};
 f=fixture({actualChangeDraft:true,renderUpdate:commit=>{
  if(!f)return Promise.resolve().then(commit);
  const busy=f.editor.view.busy,hold=armed&&!f.controller.active&&(!busy||external);
  return retain(Promise.resolve().then(async()=>{
   if(hold){shellHeld=true;await shell.promise;}commit();opener.disabled=f.editor.view.busy;const revision=++componentRevision;
   opener.updateComplete=retain(Promise.resolve().then(async()=>{if(hold&&!opener.disabled){buttonHeld=true;await buttonUpdate.promise;}if(revision===componentRevision)nativeButton.disabled=opener.disabled;}));
  }));
 }});
 opener.ownerDocument=f.document;nativeButton.ownerDocument=f.document;
 nativeButton.focus=()=>{if(nativeButton.disabled||!nativeButton.isConnected)return;focused++;f.document.activeElement=opener;opener.shadowRoot.activeElement=nativeButton;f.document.dispatchEvent(new Event('focusin'));};
 opener.focus=()=>{attempts.push({busy:f.editor.view.busy,hostDisabled:opener.disabled,nativeDisabled:nativeButton.disabled});nativeButton.focus();};
 const inspector=f.host.querySelector('#inspector');inspector.focus=()=>{inspectorFocused++;f.document.activeElement=inspector;f.document.dispatchEvent(new Event('focusin'));};
 f.editor.run=(label,work)=>{const task=(async()=>{
  if(f.editor.view.busy)return;labels.push(label);f.editor.view.busy=true;transitions.push(true);f.host.requestUpdate();
  try{await f.host.updateComplete;await work();}catch(error){f.errors.push(error);}finally{f.editor.view.busy=false;transitions.push(false);f.host.requestUpdate();}
 })();runs.push(task);void task.catch(()=>{});return task;};
 return {f,opener,nativeButton,inspector,attempts,transitions,labels,
  get shellHeld(){return shellHeld;},get buttonHeld(){return buttonHeld;},get focused(){return focused;},get inspectorFocused(){return inspectorFocused;},
  async begin(){await f.controller.begin(opener);await until(()=>f.controller.lifecycle.pendingOperations===0,'native focus fixture opened');await f.input('Exact focus return draft');},
  async preview(){f.context.prepare=async(_request,_fonts,storage)=>{const candidate=await storage.stage(new Blob([JSON.stringify({source:{render:{pixels:{hash:hash('raster-preview')}}}})]),'application/json');return {candidate,admissionId:'admission',dependencyHash:hash('dependencies')};};const command=f.editor.command;f.editor.command=async body=>{if(body.type!=='CreateTextLayer')return command.call(f.editor,body);f.commands.push(body);f.editor.view.document={...f.editor.view.document,revision:'2'};return [{type:'ImageEdited',commandId:'focus-command',correlationId:'focus-correlation',transactionId:'focus-transaction',resultingDocumentRevision:'2'}];};f.click('Preview text');await until(()=>f.controller.lifecycle.previewBytes===4&&f.controller.lifecycle.pendingOperations===0,'focus return Apply preview');},
  arm(independent=false){armed=true;external=independent;attempts.length=0;transitions.length=0;labels.length=0;},
  escape(){const e=new Event('keydown',{cancelable:true});Object.defineProperty(e,'key',{value:'Escape'});f.controller.control.dispatchEvent(e);assert.equal(e.defaultPrevented,true);},
  async busy(value){f.editor.view.busy=value;f.host.requestUpdate();await f.host.updateComplete;await opener.updateComplete;},
  openShell(){shell.resolve();},openButton(){buttonUpdate.resolve();},
  async drain(){armed=false;shell.resolve();buttonUpdate.resolve();await Promise.allSettled([...runs,...f.controller.pending]);await Promise.allSettled(updates);await f.controller.memory.drain();},
 };
}

for(const action of ['Escape','Cancel button','Apply'])test(action+' returns focus only after dispatcher, shell and native button enablement',async()=>{
 const h=retirementFocusFixture(),f=h.f;
 try{
  await h.begin();if(action==='Apply')await h.preview();const draftId=f.controller.session.draftId;h.arm();if(action==='Escape')h.escape();else f.click(action==='Apply'?'Apply text':'Cancel text edit');
  await until(()=>h.shellHeld&&!f.editor.view.busy,'retired action waiting for idle shell');assert.equal(f.controller.active,false);assert.deepEqual(h.labels,[action==='Apply'?'Apply text':'Cancel text edit']);assert.deepEqual(h.transitions,[true,false]);assert.equal(h.nativeButton.disabled,true);assert.deepEqual(h.attempts,[]);assert.equal(h.focused,0);
  if(action==='Apply'){assert.equal(f.commands.filter(row=>row.type==='CreateTextLayer').length,1);assert.equal(f.editor.view.document.revision,'2');assert.equal(f.controller.message,'Text applied and saved locally.');}else{assert.deepEqual(f.clears,[draftId]);assert.equal(f.drafts.has(draftId),false);assert.equal(f.commands.filter(row=>row.type!=='ImportFont').length,0);}
  h.openShell();await until(()=>h.buttonHeld,'retired action waiting for native button');assert.equal(h.opener.disabled,false);assert.equal(h.nativeButton.disabled,true);assert.deepEqual(h.attempts,[]);assert.equal(h.focused,0);
  h.openButton();await until(()=>f.controller.lifecycle.pendingOperations===0,'retired focus action drained');assert.deepEqual(h.attempts,[{busy:false,hostDisabled:false,nativeDisabled:false}]);assert.equal(h.focused,1);assert.equal(f.document.activeElement,h.opener);assert.equal(h.opener.shadowRoot.activeElement,h.nativeButton);assert.equal(h.inspectorFocused,0);assert.equal(f.controller.lifecycle.controlMemory.actions,0);assert.equal(f.context.held,0);assert.deepEqual(f.errors,[]);
 }finally{await h.drain();}
});

for(const boundary of ['shell','native button'])for(const cause of ['release','dispose','new session','user focus','session owner','draft owner','document revision','successor busy'])test('retired focus yields to '+cause+' during '+boundary+' update',async()=>{
 const h=retirementFocusFixture(),f=h.f;let closing,beginning;
 try{
  await h.begin();h.arm();h.escape();await until(()=>h.shellHeld&&!f.editor.view.busy,'Cancel waiting for shell');if(boundary==='native button'){h.openShell();await until(()=>h.buttonHeld,'Cancel waiting for native button');}
  assert.equal(f.controller.active,false);assert.deepEqual(h.attempts,[]);const next=new Element(f.document);
  if(cause==='release'||cause==='dispose'){closing=cause==='release'?f.controller.releaseDocument():f.controller.dispose();void closing.catch(()=>{});}
  else if(cause==='new session'){beginning=f.controller.begin(next);void beginning.catch(()=>{});await until(()=>f.controller.active,'successor native session');}
  else if(cause==='user focus'){next.focus();f.document.dispatchEvent(new Event('focusin'));}
  else if(cause==='session owner')f.editor.sessionId='successor-session';
  else if(cause==='draft owner')f.editor.draftOwner={...f.editor.draftOwner,drafts:new Map()};
  else if(cause==='document revision')f.editor.view.document={...f.editor.view.document,revision:'2'};
  else await h.busy(true);
  h.openShell();h.openButton();await Promise.all([closing,beginning]);await until(()=>f.controller.lifecycle.pendingOperations===0,'superseded focus action drained');assert.deepEqual(h.attempts,[]);assert.equal(h.focused,0);assert.equal(h.inspectorFocused,0);assert.equal(f.clears.length,1);assert.equal(f.commands.filter(row=>row.type!=='ImportFont').length,0);assert.deepEqual(f.errors,[]);
  if(cause==='new session'){assert.equal(f.controller.active,true);assert.equal(f.controller.opener,next);}if(cause==='user focus')assert.equal(f.document.activeElement,next);if(cause==='successor busy')assert.equal(f.editor.view.busy,true);
 }finally{h.openShell();h.openButton();await Promise.allSettled([closing,beginning]);await h.drain();}
});

for(const changed of ['id','revision'])test('Cancel cannot restore focus into a document '+changed+' replaced during cleanup',async()=>{
 const h=retirementFocusFixture(),f=h.f,cleanup=deferred();let entered=false;
 try{
  await h.begin();f.context.releaseRealm=()=>{entered=true;return cleanup.promise;};h.arm();h.escape();await until(()=>entered,'Cancel cleanup before retirement');assert.equal(f.controller.active,true);assert.equal(f.editor.view.busy,true);assert.deepEqual(h.attempts,[]);
  f.editor.view.document={...f.editor.view.document,[changed]:changed==='id'?'document-b':'2'};cleanup.resolve();h.openShell();h.openButton();await until(()=>f.controller.lifecycle.pendingOperations===0,'changed document Cancel drained');assert.equal(f.controller.active,false);assert.equal(f.clears.length,1);assert.equal(h.focused,0);assert.equal(h.inspectorFocused,0);assert.deepEqual(h.attempts,[]);assert.deepEqual(f.errors,[]);
 }finally{cleanup.resolve();await h.drain();f.context.releaseRealm=undefined;}
});

test('independent Cancel returns to inspector after its local render without clearing external busy',async()=>{
 const h=retirementFocusFixture(),f=h.f;
 try{
  await h.begin();const draftId=f.controller.session.draftId;await h.busy(true);h.arm(true);h.escape();await until(()=>h.shellHeld,'independent Cancel shell commit');assert.equal(f.controller.active,false);assert.equal(f.editor.view.busy,true);assert.deepEqual(h.labels,[]);assert.deepEqual(h.transitions,[]);assert.deepEqual(f.clears,[draftId]);assert.equal(f.drafts.has(draftId),false);assert.equal(h.inspectorFocused,0);assert.deepEqual(h.attempts,[]);
  h.openShell();await until(()=>f.controller.lifecycle.pendingOperations===0,'independent Cancel drained while external action remains busy');assert.equal(f.editor.view.busy,true);assert.equal(h.nativeButton.disabled,true);assert.equal(h.inspectorFocused,1);assert.equal(f.document.activeElement,h.inspector);assert.deepEqual(h.attempts,[]);assert.equal(h.focused,0);assert.equal(f.controller.lifecycle.controlMemory.actions,0);assert.equal(f.context.held,0);assert.deepEqual(f.errors,[]);
 }finally{await h.drain();}
});


test('composing Cancel preserves later deliberate focus through its first native end',async()=>{
 const h=retirementFocusFixture(),f=h.f;
 try{
  await h.begin();await f.input('pending composition Cancel',true);const draftId=f.controller.session.draftId;h.arm();f.click('Cancel text edit');await settle();assert.equal(f.controller.active,true);assert.equal(f.controller.pendingAction,'cancel');assert.equal(f.clears.length,0);
  const next=new Element(f.document);next.focus();f.document.dispatchEvent(new Event('focusin'));f.controller.control.dispatchEvent(new Event('compositionend'));await f.input('pending composition Cancel');await until(()=>h.shellHeld&&!f.editor.view.busy,'composition Cancel retired after native end');assert.equal(f.controller.active,false);h.openShell();h.openButton();await until(()=>f.controller.lifecycle.pendingOperations===0,'composition Cancel focus work drained');
  assert.deepEqual(f.clears,[draftId]);assert.equal(f.controller.cancelIntentEpoch,undefined);assert.equal(f.controller.cancelFocusEpoch,undefined);assert.equal(f.controller.cancelDispatchEpoch,undefined);assert.equal(f.document.activeElement,next);assert.deepEqual(h.attempts,[]);assert.equal(h.focused,0);assert.equal(h.inspectorFocused,0);assert.equal(f.commands.filter(row=>row.type!=='ImportFont').length,0);assert.deepEqual(f.errors,[]);
 }finally{await h.drain();}
});

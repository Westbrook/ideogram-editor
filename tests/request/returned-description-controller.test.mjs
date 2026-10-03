// Actual controllers, ControlAdapter and owned JSON/model ledger. Lit, native
// controls, font loading and text workers are explicit NON-BROWSER doubles.
// This suite claims neither browser focus behavior nor native font/raster proof.
import {allocationsURL,promptMemoryURL as promptURL,compositionObservationsURL} from '../owned-preview-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc} from 'vite';
import {inspectReturnedDescription,validateReturnedDescriptionReview,verifyReturnedDescriptionReview} from '../../dist/local/src/text/returned-description.js';
import {canonical} from '../../dist/local/src/protocol/json.js';

const roots=[process.env.IE_DRAFT_METADATA_SOURCE_ROOT,process.env.IE_NATIVE_CONTROL_API_SOURCE_ROOT,process.env.IE_NATIVE_CONTROLS_SOURCE_ROOT,process.env.RETURNED_DESCRIPTION_CORRECTION_ROOT,process.env.RETURNED_DESCRIPTION_SOURCE_ROOT,'.'].filter(Boolean);
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const compiled=path=>pathToFileURL(resolve('dist/local/'+path)).href;
async function sourceText(path){for(const root of roots){try{return await readFile(root+'/'+path,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}}throw Error('Missing controller source '+path);}
async function source(path,imports={},suffix=''){
 const original=await sourceText(path),sourceHash=createHash('sha256').update(original).digest('hex');
 let code=(await transformWithOxc(original,path)).code;
 for(const [specifier,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(specifier),JSON.stringify(url)).replaceAll("'"+specifier+"'",JSON.stringify(url));
 // Preserve the actual source identity in stacks without expanding data URLs.
 return data(code+suffix+'\n//# sourceURL=ideogram-returned-description/'+path+'?sha256='+sourceHash+'\n');
}
const modelsURL=await source('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptURL});
const adapterURL=await source('src/ui/adapters.ts'),shaURL=await source('src/protocol/sha256.ts');
const lit=data('export const nothing=null;export const html=(strings,...values)=>({strings,values});');
const returnedURL=compiled('src/text/returned-description.js'),textURL=compiled('src/protocol/text.js'),jsonURL=compiled('src/protocol/json.js'),compositionURL=compiled('src/composition/core.js');
const controllerURL=await source('src/ui/returned-description.ts',{'../observability/composition-observations.js':compositionObservationsURL,'lit':lit,'../text/returned-description.js':returnedURL,'../protocol/sha256.js':shaURL,'../observability/allocations.js':allocationsURL,'../observability/model-memory.js':modelsURL,'../observability/prompt-memory.js':promptURL,'./adapters.js':adapterURL});
const {ReturnedDescriptionEditing}=await import(controllerURL),{readOwnedJSON}=await import(modelsURL),{allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL);
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const ref=(value,mediaType='text/plain')=>{const bytes=Buffer.from(value);return {hash:digest(bytes),byteLength:String(bytes.length),mediaType};};
const flush=async()=>{for(let n=0;n<64;n++)await Promise.resolve();};
const task=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});return {promise,resolve,reject};};
const resources=()=>{const x=allocationLedger.snapshot();return {cpu:x.cpuBytes,prompt:x.promptBytes,records:x.activeRecords,handles:x.handles};};
function event(value,checked=false){const target={value,checked,isConnected:true,focus(){}};return {currentTarget:target,composedPath:()=>[target],defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};}
function templates(value){return !value||typeof value!=='object'?[]:Array.isArray(value)?value.flatMap(templates):value.strings?[value,...value.values.flatMap(templates)]:[];}
function callback(tree,name){
 for(const template of templates(tree)){
  if(name==='review'&&template.strings[0].includes('<en-button @click=')&&template.strings.join('').includes('Review supported caption text'))return template.values[0];
  if(template.strings[0].includes('<en-select label="Returned text element"')){
   if(name==='element')return template.values[1];
   if(name==='placement')return template.values[5];
   if(name==='acknowledge')return template.values[7];
   if(name==='open')return template.values[9];
  }
 }
 return undefined;
}
function captionBytes(length){
 const base=JSON.stringify({high_level_description:'Scene',compositional_deconstruction:{background:'plain',elements:[{type:'obj',desc:'Background object'},{type:'text',bbox:[100,200,300,800],text:'Cafe\u0301 東京 <b>literal</b>',desc:'Blue lettering'}]}});
 if(length===undefined)return Buffer.from(base);
 assert(Buffer.byteLength(base)<=length);return Buffer.from(base+' '.repeat(length-Buffer.byteLength(base)));
}
function fixture(t,{bytes=captionBytes(),endpoint='ideogram/v4',provenance}={}){
 const before=resources(),calls=[],opened=[],document={id:'document',revision:'4',width:1000,height:500},owner={drafts:new Map()},host={updates:0,updateComplete:Promise.resolve(),requestUpdate(){this.updates++;this.updateComplete=Promise.resolve();}};
 let candidateOwned=true,pageProvider;
 const editor={sessionId:'session',draftOwner:owner,view:{ready:true,document},ownedJSON:(path,owner,init,owns,maxBytes,kind)=>readOwnedJSON(transport,path,{owner,init,owns,maxBytes,kind})};
 const view={jobId:'job',documentId:'document',request:{endpoint},provenance:provenance??{complete:true,quarantined:false,inspection:'supported',returnedPrompt:ref(bytes)}};
 const page=offset=>({bytes:bytes.subarray(offset,offset+32768).toString('base64'),byteLength:String(bytes.length),offset:String(offset),nextOffset:offset+32768<bytes.length?String(offset+32768):null});
 const response=value=>{const raw=JSON.stringify(value);return new Response(raw,{headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(raw))}});};
 async function transport(path,init){calls.push({path,init});const offset=Number(new URL(path,'http://127.0.0.1').searchParams.get('offset'));return pageProvider?pageProvider(offset,init):response(page(offset));}
 const owns=()=>candidateOwned&&editor.sessionId==='session'&&editor.draftOwner===owner&&editor.view.document?.id==='document'&&editor.view.document.revision==='4';
 const controller=new ReturnedDescriptionEditing(host,editor,async(trigger,proposal)=>opened.push(structuredClone(proposal))),render=()=>controller.render(view,'attempt',owns);
 async function drain(){await task();await flush();while(controller.pending.size)await Promise.allSettled([...controller.pending]);await flush();}
 const click=async name=>{const fn=callback(render(),name);assert.equal(typeof fn,'function',name+' callback');fn(event());await drain();};
 const set=async(name,value,checked=false)=>{const fn=callback(render(),name);assert.equal(typeof fn,'function',name+' callback');fn(event(value,checked));await flush();};
 t.after(async()=>{await controller.releaseDocument();await flush();assert.deepEqual(resources(),before);});
 return {controller,editor,host,view,bytes,calls,opened,render,page,response,click,set,drain,setPage:fn=>pageProvider=fn,loseCandidate:()=>candidateOwned=false};
}
const change=(f,kind)=>{if(kind==='document')f.editor.view.document={...f.editor.view.document,id:'other'};if(kind==='revision')f.editor.view.document={...f.editor.view.document,revision:'5'};if(kind==='session')f.editor.sessionId='successor';if(kind==='owner')f.editor.draftOwner={drafts:new Map()};if(kind==='candidate')f.loseCandidate();};

for(const size of [32768,65536,65537])test('caption pages retain exact '+size+' bytes and stop at the final declared boundary',async t=>{
 const f=fixture(t,{bytes:captionBytes(size)});await f.click('review');assert.deepEqual(f.calls.map(c=>Number(new URL(c.path,'http://127.0.0.1').searchParams.get('offset'))),Array.from({length:Math.ceil(size/32768)},(_,index)=>index*32768));
 for(const call of f.calls){const url=new URL(call.path,'http://127.0.0.1');assert.equal(url.searchParams.get('attempt'),'attempt');assert.equal(url.searchParams.get('prompt'),'returned');assert.equal(url.pathname,'/api/v1/jobs/job/candidates');}
 assert.equal(f.controller.current.value.value.state,'available');assert.equal(f.controller.current.value.target.returnedPrompt.hash,digest(f.bytes));
 await f.set('element','1');await f.set('acknowledge','',true);await f.click('open');assert.equal(f.opened.length,1);assert.equal(f.opened[0].literal,'Cafe\u0301 東京 <b>literal</b>');assert.equal(f.opened[0].selection.elementIndex,1);assert.deepEqual(f.opened[0].placement,{x:200,y:50});assert.deepEqual(f.opened[0].frame,{width:600,height:100});
});

for(const defect of ['length','offset','next','empty','hash'])test('caption '+defect+' mismatch cannot install a selectable model',async t=>{
 const f=fixture(t);f.setPage(offset=>{const p=f.page(offset);if(defect==='length')p.byteLength=String(f.bytes.length+1);if(defect==='offset')p.offset='1';if(defect==='next')p.nextOffset=String(f.bytes.length);if(defect==='empty')p.bytes='';if(defect==='hash'){const bytes=Buffer.from(p.bytes,'base64');bytes[0]^=1;p.bytes=bytes.toString('base64');}return f.response(p);});
 await f.click('review');assert.equal(f.controller.current,undefined);assert.equal(f.opened.length,0);assert.match(f.controller.message,/identity|boundary|size/i);
});

for(const kind of ['document','revision','session','owner','candidate'])for(const fails of [false,true])test('pending caption '+(fails?'failure':'success')+' cannot publish after '+kind+' replacement',async t=>{
 const f=fixture(t),gate=deferred();f.setPage(()=>gate.promise);callback(f.render(),'review')(event());await task();await flush();assert.equal(f.calls.length,1);change(f,kind);const updates=f.host.updates;
 if(fails)gate.reject(Error('obsolete caption failure'));else gate.resolve(f.response(f.page(0)));await f.drain();assert.equal(f.controller.current,undefined);assert.equal(f.opened.length,0);assert.equal(f.host.updates,updates);
});

for(const action of ['review','open'])test('deferred '+action+' click is inert when candidate ownership changes before settled dispatch',async t=>{
 const f=fixture(t);if(action==='open'){await f.click('review');await f.set('element','1');await f.set('acknowledge','',true);}
 const reads=f.calls.length;callback(f.render(),action)(event());f.loseCandidate();await f.drain();assert.equal(f.calls.length,reads);assert.equal(f.opened.length,0);
});

test('document release aborts a pending native response and drains all caption/model leases',async t=>{
 const f=fixture(t),gate=deferred();let canceled=0;f.setPage((_offset,init)=>{init.signal.addEventListener('abort',()=>{canceled++;gate.reject(new DOMException('closed','AbortError'));},{once:true});return gate.promise;});
 callback(f.render(),'review')(event());await task();await flush();assert.equal(f.calls.length,1);await f.controller.releaseDocument();assert.equal(canceled,1);assert.equal(f.controller.current,undefined);assert.equal(f.controller.reads.size,0);assert.equal(f.controller.pending.size,0);assert.equal(f.opened.length,0);
});

test('closing during a native page body cancels and unlocks the real response before releasing its lease',async t=>{
 const f=fixture(t);let canceled=0,response;
 f.setPage(()=>{response=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){canceled++;}}),{headers:{'content-length':'100','content-type':'application/json'}});return response;});
 callback(f.render(),'review')(event());await task();await flush();assert.equal(response.body.locked,true);await f.controller.releaseDocument();assert.equal(canceled,1);assert.equal(response.body.locked,false);assert.equal(f.controller.pending.size,0);assert.equal(f.controller.current,undefined);
});

test('failed native reader unlock stays owned until an explicit document release retries it',async t=>{
 const f=fixture(t);let releases=0,response;
 f.setPage(offset=>{response=f.response(f.page(offset));const reader=response.body.getReader();response.body.getReader=()=>({read:()=>reader.read(),cancel:()=>reader.cancel(),get closed(){return reader.closed;},releaseLock(){if(++releases<=2)throw Error('temporary unlock refusal');reader.releaseLock();}});return response;});
 await f.click('review');assert.equal(f.controller.current,undefined);assert.equal(f.controller.cleanup.size,1);assert.equal(response.body.locked,true);assert(allocationLedger.snapshot().promptBytes>0,'failed reader remains charged');
 await f.controller.releaseDocument();assert.equal(releases,3);assert.equal(response.body.locked,false);assert.equal(f.controller.cleanup.size,0);
});

test('current caption failure remains visible and deliberate new inspection can retry',async t=>{
 const f=fixture(t);f.setPage(()=>Promise.reject(Error('owned page failure')));await f.click('review');assert.equal(f.controller.message,'owned page failure');f.setPage(undefined);await f.click('review');assert.equal(f.controller.current.value.value.state,'available');
});

test('V45 unavailable and unsupported/partial/quarantined captions offer no network action',async t=>{
 for(const configuration of [{endpoint:'ideogram/v4.5',provenance:{schemaVersion:2,complete:true,quarantined:false,inspection:'unavailable',returnedPrompt:null}},{provenance:{complete:false,quarantined:false,inspection:'supported',returnedPrompt:ref(captionBytes())}},{provenance:{complete:true,quarantined:true,inspection:'supported',returnedPrompt:ref(captionBytes())}},{provenance:{complete:true,quarantined:false,inspection:'opaque',returnedPrompt:ref(captionBytes())}}]){
  const f=fixture(t,configuration);assert.equal(callback(f.render(),'review'),undefined);assert.equal(callback(f.render(),'open'),undefined);await f.drain();assert.deepEqual(f.calls,[]);
 }
});

test('element or placement edits invalidate acknowledgement; released model remains pinned until the native handoff settles',async t=>{
 const f=fixture(t);await f.click('review');await f.set('element','1');await f.set('acknowledge','',true);await f.set('placement','keep-both');assert.equal(f.controller.acknowledged,false);await f.set('acknowledge','',true);
 const gate=deferred();f.controller.begin=async()=>gate.promise;callback(f.render(),'open')(event());await task();await flush();const release=f.controller.releaseDocument();await flush();assert(allocationLedger.snapshot().promptBytes>0,'in-flight handoff retains selected model');gate.resolve();await release;assert.equal(f.controller.current,undefined);assert.equal(f.controller.pending.size,0);
});

// Narrow native dependencies: ownership, saving and final review are real;
// rendering/font admission are named deterministic doubles below.
const model=data('export function createDraftModel(){let value="",draft="",composing=false;return {value:{get:()=>value},draft:{get:()=>draft},isComposing:{get:()=>composing},setValue(v){value=draft=v;},endComposition(v){composing=false;value=draft=v;}};}');
const bridge=data('export class EditingController{constructor(host,options){this.options=options;}hostDisconnected(){}hostConnected(){}sync(){this.options.control().value=this.options.model.value.get();}}');
const textClient=data('let bytes=0;export const textMemory={get snapshot(){return {textBytes:bytes};},reserve(n){bytes+=n;let live=true;return {release(){if(live){live=false;bytes-=n;}}};}};export class TextRenderer{dispose(){}cancel(){}}export function releasePrepared(){}');
const library=data('import {cloneOwnedModel} from '+JSON.stringify(modelsURL)+';export const fontChoices=[{id:"fixture-font",sha256:"'+('1'.repeat(64))+'"}];export class TextLibrary{constructor(editor){this.editor=editor;}async bundled(id){return cloneOwnedModel("fixture-font-version",await this.editor.fixtureFont(id));}load(fonts){return Promise.resolve(cloneOwnedModel("fixture-font-input",fonts.map(font=>({hash:font.bytes.hash,bytes:new Blob([]),faceIndex:0,origin:font.origin,license:{hash:font.licenseRecord.hash,embedding:"permitted"}}))));}clear(){}invalidate(){}releaseDocument(){return Promise.resolve();}get lifecycle(){return {retainedFontBytes:0};}}');
const phases=data('export const browserPhases={recorder:{timestamp:()=>0,start(){return {end(){}};}}};');
const contracts=data('import {SHA256} from '+JSON.stringify(shaURL)+';export class TextFailure extends Error{}export const LIMITS={textBytes:16384,faces:16,faceBytes:16777216};export const hashBytes=async bytes=>new SHA256().update(bytes).digest();export const cancelTextAssetResponse=async()=>{};export const readTextAssetResponse=async response=>response.blob();export const retryTextAssetCleanup=async()=>true;export const retainTextAssetCleanup=()=>false;');
const durable=data('export class DurableTextPreparation{constructor(storage){this.storage=storage;}async prepare(request,fonts){const pixels={hash:"sha256:'+('2'.repeat(64))+'",byteLength:"4",mediaType:"application/x-ideogram-rgba8"};const candidate=await this.storage.stage(new Blob([JSON.stringify({source:{render:{pixels}}})]),"application/json");return {candidate,admissionId:"local_admission",dependencyHash:"sha256:'+('3'.repeat(64))+'"};}dispose(){}cancel(){}}export const releaseTextRealm=async()=>{};');
const fontRelink=data('export const hashRelinkInputs=async()=>{throw Error("unused font relink");};');
const controlMemoryURL=await source('src/state/control-memory.ts',{'../observability/allocations.js':allocationsURL});
const nativeMemoryURL=await source('src/ui/native-control-memory.ts',{'../observability/allocations.js':allocationsURL,'../observability/model-memory.js':modelsURL});
const nativePreviewURL=await source('src/ui/native-text-preview.ts');
const splitURL=await source('src/text/split.ts');
const {cloneOwnedModel}=await import(modelsURL);
const nativeURL=await source('src/ui/native-text.ts',{'../text/split.js':splitURL,'./native-text-preview.js':nativePreviewURL,'./native-control-memory.js':nativeMemoryURL,'../state/control-memory.js':controlMemoryURL,'../observability/prompt-memory.js':promptURL,'lit':lit,'../composition/core.js':compositionURL,'../text/returned-description.js':returnedURL,'@en-reve/primitives/interactions/editing-controller.js':bridge,'@en-reve/primitives/state/draft.js':model,'../text/client.js':textClient,'../text/durable.js':durable,'../protocol/text.js':textURL,'../text/contracts.js':contracts,'../protocol/json.js':jsonURL,'./adapters.js':adapterURL,'./text-library.js':library,'../observability/browser.js':phases,'../observability/allocations.js':allocationsURL,'./font-relink.js':fontRelink,'../observability/model-memory.js':modelsURL});
const {NativeTextEditing}=await import(nativeURL);
function control(){const node=new EventTarget();return Object.assign(node,{value:'',parentNode:null,isConnected:true,selectionStart:0,selectionEnd:0,selectionDirection:'none',scrollTop:0,scrollLeft:0,setAttribute(){},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;},focus(){globalThis.document.activeElement=this;}});}
const fontFor=label=>({schemaVersion:1,id:digest('font-'+label),bytes:ref('font bytes '+label,'application/octet-stream'),faceIndex:0,format:'static-ttf',parserProfile:'sfnt-static-1-freetype-canvaskit040',fsType:0,licenseRecord:ref('license '+label),origin:'local-file',embedding:'permitted'});
function proposal(){const bytes=captionBytes(),element=inspectReturnedDescription(bytes).elements[0];return {selection:{kind:'returned-description-selection-1',jobId:'job',attemptId:'attempt',returnedPrompt:ref(bytes),elementIndex:element.index,elementHash:element.elementHash,placementChoice:'separate-placement',duplicationAcknowledged:true},literal:element.literal,frame:{width:120,height:40},placement:{x:10,y:20}};}
function nativeFixture(t){
 const before=resources(),priorDocument=globalThis.document,events=new EventTarget();globalThis.document={createElement:control,addEventListener:events.addEventListener.bind(events),activeElement:null};
 const saved=[],cleared=[],commands=[],font=fontFor('first'),host={updateComplete:Promise.resolve(),requestUpdate(){this.updateComplete=Promise.resolve();},querySelector(){return null;}},owner={drafts:new Map([['unrelated',{generation:'9',savedGeneration:'9',text:'Preserve this draft'}]])};
 const editor={sessionId:'session',draftOwner:owner,view:{ready:true,busy:false,document:{id:'document',revision:'4',width:1000,height:500},image:{layers:[]}},ui:{drafts:[]},pinViewModels:()=>()=>{},registerDraft:()=>()=>{},fixtureFont:async()=>font,fontAssets:async fonts=>fonts.map((font,index)=>({id:'font_'+index,font})),async ownedFontAssets(...args){return cloneOwnedModel('fixture-font-assets',await this.fontAssets(...args));},async ownedStageTextBlob(...args){return cloneOwnedModel('fixture-stage-ref',await this.stageTextBlob(...args));},async withCommandEvents(body,work,...args){const result=cloneOwnedModel('fixture-command-events',await this.command(body,...args));try{return await work(result.value);}finally{result.release();}},async withJSON(path,name,work,init,owns,maxBytes,kind){const result=await this.ownedJSON(path,name,init,owns,maxBytes,kind);try{return await work(result.value);}finally{result.release();}},session:{transport:async()=>new Response(null,{status:200})},json:async()=>{throw Error('unexpected native JSON read');},ownedJSON(path,owner,init,owns,maxBytes,kind){return readOwnedJSON(async()=>{const raw=JSON.stringify(await this.json(path,init));return new Response(raw,{headers:{'content-length':String(Buffer.byteLength(raw)),'content-type':'application/json'}});},path,{owner,init,owns,maxBytes,kind});},fail:error=>{throw error;},run:async(_label,work)=>work(),stageTextBlob:async(blob,media)=>ref(Buffer.from(await blob.arrayBuffer()),media),select(){},changeDraft(id,kind,text,target,composing,revision){saved.push({id,kind,value:JSON.parse(text),target,composing,revision});const generation=String(BigInt(this.draftOwner.drafts.get(id)?.generation??'0')+1n);this.draftOwner.drafts.set(id,{generation,savedGeneration:generation,text});},flushDrafts:async()=>{},clearDraft:async id=>{cleared.push(id);editor.draftOwner.drafts.delete(id);},command:async(body,document)=>{commands.push({body:structuredClone(body),document:structuredClone(document)});return [{type:'ImageEdited'}];}};
 const native=new NativeTextEditing(host,editor,()=>{},point=>point);
 t.after(async()=>{try{await native.releaseDocument();native.abort.abort();await flush();assert.deepEqual(resources(),before);}finally{globalThis.document=priorDocument;}});
 return {native,editor,host,font,saved,cleared,commands,owner,trigger:{isConnected:true,focus(){}}};
}

test('native proposal is synchronously admitted and later caller mutations cannot overwrite it or an unrelated draft',async t=>{
 const f=nativeFixture(t),gate=deferred(),value=proposal(),original=structuredClone(value);f.editor.fixtureFont=()=>gate.promise;const pending=f.native.beginFromReturnedDescription(f.trigger,value);value.literal='caller mutation';value.selection.elementHash=digest('changed');value.frame.width=800;assert.equal(f.saved.length,0);gate.resolve(f.font);await pending;await flush();
 assert.equal(f.native.session.text,original.literal);assert.deepEqual(f.native.session.description,original.selection);assert.deepEqual(f.saved[0].value.description,original.selection);assert.deepEqual(f.owner.drafts.get('unrelated'),{generation:'9',savedGeneration:'9',text:'Preserve this draft'});
 const id=f.native.session.draftId,count=f.saved.length;await assert.rejects(f.native.beginFromReturnedDescription(f.trigger,proposal()),/current text draft/);assert.equal(f.native.session.draftId,id);assert.equal(f.saved.length,count);
});

for(const change of ['document','session','owner','close'])test('pending native proposal cannot create a draft after '+change,async t=>{
 const f=nativeFixture(t),gate=deferred();f.editor.fixtureFont=()=>gate.promise;const pending=f.native.beginFromReturnedDescription(f.trigger,proposal());let closing;
 if(change==='document')f.editor.view.document={...f.editor.view.document,id:'successor'};if(change==='session')f.editor.sessionId='successor';if(change==='owner')f.editor.draftOwner={drafts:new Map()};if(change==='close')closing=f.native.releaseDocument();gate.resolve(f.font);await pending;await closing;await flush();assert.equal(f.native.session,undefined);assert.deepEqual(f.saved,[]);assert.deepEqual(f.commands,[]);
});

test('native proposal admission refuses before font loading when model capacity is unavailable',async t=>{
 const f=nativeFixture(t);let calls=0;f.editor.fixtureFont=async()=>{calls++;return f.font;};const pressure=allocationLedger.reserve({owner:'returned-test-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-allocationLedger.snapshot().cpuBytes});
 try{await assert.rejects(Promise.resolve().then(()=>f.native.beginFromReturnedDescription(f.trigger,proposal())),/ALLOCATION_BUDGET/);assert.equal(calls,0);assert.equal(f.native.session,undefined);assert.deepEqual(f.saved,[]);}finally{pressure.release();}
});

test('recovered draft3 preserves description intent through local text changes and final review rebinds literal, font and placement',async t=>{
 const f=nativeFixture(t),original=proposal(),style={primaryFont:f.font.bytes.hash,explicitFallbacks:[],sizePx:16,lineHeightMultiplier:1.2,fill:[20,40,60,255],align:'start',direction:'auto'},checkpoint={id:'recovered',kind:'text',status:'saved-unapplied',documentId:'document',targetLayerId:null,expectedDocumentRevision:'4',generation:'3'};
 f.editor.ui.drafts=[checkpoint];f.editor.json=async()=>({draft:checkpoint,value:{schemaVersion:3,kind:'text-draft-3',textUtf8:ref(original.literal),style,frame:original.frame,fonts:[f.font],placement:original.placement,description:original.selection}});f.native.readText=async()=>cloneOwnedModel('fixture-text',original.literal);await f.native.sync();await flush();assert.deepEqual(f.native.session.description,original.selection);assert.equal(f.native.session.draftId,'recovered');
 const newFont=fontFor('changed'),next=f.native.proposeSession(f.native.session,4096,s=>{s.text='User edited Café 東京';s.fonts=[newFont];s.style={...s.style,primaryFont:newFont.bytes.hash,sizePx:24};s.frame={width:140,height:50};s.placement={x:33,y:44};});f.native.acceptSession(next);const s=f.native.session;assert.deepEqual(f.saved.at(-1).value.description,original.selection);
 f.native.preview={revision:f.native.revision,hash:'sha256:'+'2'.repeat(64),overflow:false,width:1,height:1,pixels:new Uint8ClampedArray(4)};await f.native.run('Apply text',()=>f.native.apply());
 assert.equal(f.commands.length,1);const command=f.commands[0].body;assert.equal(command.type,'CreateTextFromReturnedDescription');validateReturnedDescriptionReview(command.description);assert.equal(command.description.documentRevision,'4');assert.deepEqual(command.description.placement,{x:33,y:44});assert.deepEqual(command.description.literal,ref(s.text));assert.equal(command.description.styleHash,digest(canonical(s.style)));assert.equal(command.description.fontsHash,digest(canonical([newFont])));assert.equal(command.description.elementHash,original.selection.elementHash);
 verifyReturnedDescriptionReview(command.description,captionBytes(),{text:{textUtf8:ref(s.text),style:s.style,frame:s.frame,fonts:s.fonts}});assert.equal(f.native.session,undefined);assert.deepEqual(f.owner.drafts.get('unrelated'),{generation:'9',savedGeneration:'9',text:'Preserve this draft'});
});

for(const change of ['session','owner'])test('admitted native session cannot save or cancel an unrelated '+change+' owner',async t=>{
 const f=nativeFixture(t);await f.native.beginFromReturnedDescription(f.trigger,proposal());await flush();const id=f.native.session.draftId,count=f.saved.length;
 if(change==='session')f.editor.sessionId='successor';else f.editor.draftOwner={drafts:new Map([[id,{generation:'1',savedGeneration:'1',text:'Successor must remain'}]])};
 f.native.input({value:'Old controller input',isComposing:false});clearTimeout(f.native.timer);f.native.timer=undefined;await assert.rejects(f.native.cancel(),/owner changed/);assert.equal(f.saved.length,count);assert.deepEqual(f.cleared,[]);assert.deepEqual(f.commands,[]);if(change==='owner')assert.equal(f.editor.draftOwner.drafts.get(id).text,'Successor must remain');
});

test('pending draft3 restore refuses a replaced owner and a fresh explicit retry retains its intent',async t=>{
 const f=nativeFixture(t),value=proposal(),gate=deferred(),checkpoint={id:'recovered',kind:'text',status:'saved-unapplied',documentId:'document',targetLayerId:null,expectedDocumentRevision:'4',generation:'1'},payload={draft:checkpoint,value:{schemaVersion:3,kind:'text-draft-3',textUtf8:ref(value.literal),style:{primaryFont:f.font.bytes.hash},frame:value.frame,fonts:[f.font],placement:value.placement,description:value.selection}};
 f.editor.ui.drafts=[checkpoint];f.editor.json=()=>gate.promise;f.native.readText=async()=>cloneOwnedModel('fixture-text',value.literal);const pending=f.native.sync();f.editor.draftOwner={drafts:new Map()};gate.resolve(payload);await pending;assert.equal(f.native.session,undefined);assert.deepEqual(f.saved,[]);
 f.editor.json=async()=>payload;await f.native.sync();await flush();assert.deepEqual(f.native.session.description,value.selection);assert.equal(f.native.session.text,value.literal);
});


const {compositionObservations:inspectionObserver}=await import(compositionObservationsURL);
function inspectionSnapshot(){const owner=inspectionObserver.readSnapshot();try{return structuredClone(owner.value);}finally{owner.release();}}
test('multi-page returned caption records one complete logical input extent',async t=>{
 const f=fixture(t,{bytes:captionBytes(65537)}),before=inspectionSnapshot();await f.click('review');const after=inspectionSnapshot(),rows=after.records.filter(row=>row.sequence>before.cursor);
 assert.equal(f.calls.length,3);assert.deepEqual(rows.filter(row=>row.kind==='raw-inspection-begin').map(row=>[row.sourceHash,row.sourceBytes,row.mode]),[[digest(f.bytes),65537,'decode']]);
 assert.deepEqual(rows.filter(row=>row.kind==='raw-inspection-read').map(row=>row.receivedBytes),[65537]);assert.deepEqual(rows.filter(row=>row.kind==='raw-inspection-end').map(row=>row.outcome),['decoded']);assert.equal(after.activeInspections,0);assert.equal(after.inspectionInvalid,before.inspectionInvalid);
});
test('failed returned caption hash verification cannot complete its materialized-input witness',async t=>{
 const f=fixture(t),before=inspectionSnapshot();f.setPage(offset=>{const p=f.page(offset),bytes=Buffer.from(p.bytes,'base64');bytes[0]^=1;p.bytes=bytes.toString('base64');return f.response(p);});await f.click('review');
 const after=inspectionSnapshot(),rows=after.records.filter(row=>row.sequence>before.cursor);assert.equal(f.controller.current,undefined);assert.deepEqual(rows.filter(row=>row.kind==='raw-inspection-read').map(row=>row.receivedBytes),[f.bytes.length]);assert.deepEqual(rows.filter(row=>row.kind==='raw-inspection-end').map(row=>row.outcome),['failed']);assert.equal(after.activeInspections,0);
});

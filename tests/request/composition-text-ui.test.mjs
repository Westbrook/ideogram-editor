// Real controller/exporter and model accounting with a controlled owned response.
// These cases establish local UI authority and retirement, not provider or browser qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc} from 'vite';

const support=await import(pathToFileURL(resolve(process.env.REQUEST_PROMPT_TEST_ROOT??'.','tests/request/request-controller-module.mjs')).href);
const {RequestEditing,allocationLedger,createOwnedModel,modelPayloadBytes,readOwnedJSON,modelMemoryURL,promptMemoryURL}=support;
const local=name=>pathToFileURL(resolve('dist/local/src/'+name+'.js')).href;
const {emptyComposition,emptyElement,serialize,linkField}=await import(local('composition/core'));
const {canonical}=await import(local('protocol/json'));
const {hash}=await import(local('request/core'));
const {newV45Draft,operations,labels}=await import(local('request/family'));
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}');
const source=new URL('../../src/ui/request-composition-text.ts',import.meta.url);
let compiled=(await transformWithOxc(await readFile(source,'utf8'),source.pathname)).code;
for(const [name,url]of Object.entries({lit,'../composition/text-export.js':local('composition/text-export'),'../protocol/json.js':local('protocol/json'),'../request/core.js':local('request/core'),'../observability/model-memory.js':modelMemoryURL,'../observability/prompt-memory.js':promptMemoryURL})){
 compiled=compiled.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
}
const {CompositionTextEditing}=await import(data(compiled));
const flush=async()=>{for(let count=0;count<80;count++)await Promise.resolve();};
const turn=async()=>{await new Promise(resolve=>setTimeout(resolve,0));await flush();};
const usage=()=>{const row=allocationLedger.snapshot();return {cpuBytes:row.cpuBytes,promptBytes:row.promptBytes,activeRecords:row.activeRecords,handles:row.handles};};
const ref=(text,mediaType='text/plain')=>({hash:hash(text),byteLength:String(Buffer.byteLength(text)),mediaType});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function find(template,part){if(!template||typeof template!=='object')return;if(template.strings?.some(value=>value.includes(part)))return template;for(const value of Array.isArray(template)?template:template.values??[]){const result=find(value,part);if(result)return result;}}
function binding(template,key){assert(template,'Rendered template');const index=template.strings.findIndex(value=>value.endsWith(key));assert(index>=0,'Rendered binding '+key);return template.values[index];}
function handler(template,id){if(!template||typeof template!=='object')return;if(template.strings){const index=template.strings.findIndex(value=>value.includes('id="'+id+'"'));if(index>=0){for(let at=index;at<template.strings.length;at++){if(template.strings[at].endsWith('@click='))return template.values[at];if(at>index&&template.strings[at].includes('</en-button>'))break;}}}for(const value of Array.isArray(template)?template:template.values??[]){const result=handler(value,id);if(result)return result;}}
function text(template){if(template===null||template===undefined||typeof template==='function')return '';if(Array.isArray(template))return template.map(text).join('');if(typeof template!=='object')return String(template);return template.strings?template.strings.map((part,index)=>part+text(template.values[index])).join(''):'';}
function approved(){
 const composition=emptyComposition(512,256,'composition'),layer={id:'native',version:'3',kind:'text',text:'Café 東京',appearance:'Blue heading',bounds:{rect:[32,16,128,48],transform:[1,0,0,1,0,0]}};
 composition.scene='A quiet blue poster';composition.background='Plain cream background';
 const title=emptyElement('text','title');title.text=linkField('text-content',layer);title.desc.value='Blue heading';
 const omitted=emptyElement('text','omitted');omitted.text.value='EXCLUDED PRIVATE TEXT';omitted.excluded=true;
 composition.elements=[title,omitted];const layers=[layer],bindings={native:'native'},projected=serialize(composition,layers,bindings);
 composition.review={serializer:'caption-json-1',sourceId:composition.id,frame:structuredClone(composition.frame),request:structuredClone(composition.request),dependencies:projected.dependencies,boxes:projected.boxes,prompt:ref(projected.prompt)};
 const reference={id:composition.id,value:ref(canonical(composition),'application/json'),bindings:structuredClone(bindings)};
 return {value:{composition,compositionRef:structuredClone(reference),layers,bindings,revision:'7'},reference};
}
function fixture(t){
 const baseline=usage(),initial=approved(),models=[],draftModels=[],holds=[],reads=[],applications=[],gates=[];let controller,rendered,generation=0,readNext=null,renderGate=null,applyFailure=null,closed=false;
 const root=createOwnedModel('composition-text-ui-draft',4096,()=>newV45Draft(ref('Keep the prior prompt')),'prompt');draftModels.push(root);let currentRoot=root,draft=root.value;
 const editor={view:{document:{id:'document',revision:'7',width:512,height:256},image:{composition:structuredClone(initial.reference)}},draftOwner:{},
  async ownedJSON(path,owner,options,owns,maxBytes,kind){
   const row={path,owner,options,owns,maxBytes,kind};reads.push(row);const next=readNext;readNext=null;
   const value=next?await next.promise:structuredClone(initial.value);
   const model=createOwnedModel('composition-text-ui-response',modelPayloadBytes(value),()=>structuredClone(value),'prompt');models.push(model);row.model=model;return model;
  }};
 const action=(_event,work)=>work();
 const host={updateComplete:Promise.resolve(),focuses:[],requestUpdate(){const gate=renderGate;this.updateComplete=Promise.resolve().then(async()=>{if(gate)await gate.promise;rendered=controller.render(action);});},querySelector(selector){return {focus:()=>this.focuses.push(selector)};}};
 controller=new CompositionTextEditing(host,editor,{draft:()=>draft,owns(){const owner=editor.draftOwner,revision=editor.view.document.revision,documentId=editor.view.document.id,prior=draft,stamp=generation,operation=draft.operation;return ()=>owner===editor.draftOwner&&revision===editor.view.document.revision&&documentId===editor.view.document.id&&prior===draft&&stamp===generation&&operation===draft.operation;},hold(){const release=currentRoot.pin(),row={draft,released:false};holds.push(row);return ()=>{assert(!row.released,'Draft hold released once');row.released=true;release();};},apply(expected,prompt,composition,review){assert.equal(expected,draft,'Only the exact current draft may be changed');if(applyFailure)throw applyFailure;applications.push({expected,prompt,composition:structuredClone(composition),review:structuredClone(review)});}});
 rendered=controller.render(action);
 function blockRead(){const gate=deferred();gates.push(gate);readNext=gate;return {...gate,resolve(value=structuredClone(initial.value)){gate.resolve(value);}};}
 function change(boundary){
  if(boundary==='draft'){const next=createOwnedModel('composition-text-ui-replacement',4096,()=>structuredClone(draft),'prompt');draftModels.push(next);currentRoot.release();currentRoot=next;draft=next.value;}
  if(boundary==='owner')editor.draftOwner={};
  if(boundary==='generation')generation++;
  if(boundary==='operation')draft.operation='transform-v45';
  if(boundary==='document')editor.view.document={...editor.view.document,id:'other-document'};
  if(boundary==='revision')editor.view.document={...editor.view.document,revision:'8'};
  if(boundary==='source-ref')editor.view.image.composition={...editor.view.image.composition,value:ref('replacement source','application/json')};
  if(boundary==='source-bindings')editor.view.image.composition={...editor.view.image.composition,bindings:{native:'other-native'}};
 }
 const close=async()=>{if(closed)return;closed=true;for(const gate of gates)gate.resolve(structuredClone(initial.value));renderGate?.resolve();await controller.dispose();for(const model of draftModels)model.release();await flush();assert(holds.every(row=>row.released),'Every exact-draft hold retires');for(const model of models)assert.throws(()=>{const unpin=model.pin();unpin();},/MODEL_MEMORY_RELEASED/,'Each owned Composition response releases');assert.deepEqual(usage(),baseline,'Preview, scratch, response and draft owners drain');};t.after(close);
 return {controller,editor,host,initial,reads,models,holds,applications,close,blockRead,change,draft:()=>draft,template:()=>rendered,async repaint(){host.requestUpdate();await flush();},async click(id){const callback=handler(rendered,id);assert.equal(typeof callback,'function',id);await callback({});await flush();},callback:id=>handler(rendered,id),failApply(error){applyFailure=error;},pauseRender(){renderGate=deferred();const release=()=>{const gate=renderGate;renderGate=null;gate.resolve();};release.fail=error=>{const gate=renderGate;renderGate=null;gate.reject(error);};return release;}};
}

test('Composition text preview does not apply; explicit confirmation retains exactly the displayed brief and source once',async t=>{
 const f=fixture(t),before=structuredClone(f.draft()),sourceBefore=structuredClone(f.initial.value),reference=structuredClone(f.editor.view.image.composition);
 await f.click('request-composition-text-prepare');assert.equal(f.reads.length,1);assert.equal(f.reads[0].path,'/api/v1/documents/document/composition?revision=7');assert.equal(f.reads[0].maxBytes,8*1024**2);assert.equal(f.reads[0].kind,'prompt');assert.equal(f.applications.length,0);assert.deepEqual(f.draft(),before);
 const card=find(f.template(),'id="request-composition-text-preview"'),prompt=binding(card,'.value=');assert.equal(typeof prompt,'string');assert.match(prompt,/Café 東京/);assert(!prompt.includes('EXCLUDED PRIVATE TEXT'));assert(!prompt.startsWith('{'));assert.match(text(card),/1 explicitly excluded/);assert.match(text(card),/512.*256/s);assert.match(text(card),/Confirming does not generate an image/);
 assert(f.holds.some(row=>!row.released),'The displayed preview pins its exact draft');await f.click('request-composition-text-confirm');assert.equal(f.applications.length,1);const accepted=f.applications[0];assert.equal(accepted.prompt,prompt);assert.equal(accepted.expected,f.draft());assert.deepEqual(accepted.composition,reference);assert.deepEqual(accepted.review.sourceProjection,sourceBefore.composition.review);assert.deepEqual(accepted.review.prompt,ref(prompt));assert.deepEqual(f.initial.value,sourceBefore);assert.equal(find(f.template(),'id="request-composition-text-preview"'),undefined);assert.throws(()=>f.controller.accept(),/changed|preview/i);assert.equal(f.applications.length,1);
});

for(const boundary of ['draft','owner','generation','operation','document','revision','source-ref','source-bindings']){
 test('a pending Composition read cannot publish after '+boundary+' changes',async t=>{
  const f=fixture(t),gate=f.blockRead(),pending=f.controller.prepare();assert.equal(f.reads.length,1);f.change(boundary);gate.resolve();await pending;await flush();assert.equal(find(f.template(),'id="request-composition-text-preview"'),undefined);assert.equal(f.applications.length,0);assert.throws(()=>f.controller.accept(),/changed|preview/i);
 });
 test('confirmation refuses a preview after '+boundary+' changes',async t=>{
  const f=fixture(t);await f.controller.prepare();await flush();f.change(boundary);await f.repaint();assert.throws(()=>f.controller.accept(),/changed|preview/i);assert.equal(f.applications.length,0);assert.match(text(f.template()),/changed|new preview/i);
 });
}

test('missing local approval releases the read without creating an actionable preview',async t=>{
 const f=fixture(t),gate=f.blockRead(),pending=f.controller.prepare(),value=structuredClone(f.initial.value);value.composition.review=null;gate.resolve(value);await assert.rejects(pending,/approve|projection/i);await flush();assert.equal(f.applications.length,0);assert.equal(find(f.template(),'id="request-composition-text-preview"'),undefined);
});

for(const mismatch of ['source-reference','response-revision','bindings','linked-layer'])test('Composition export refuses current '+mismatch+' disagreement while preserving the draft',async t=>{
 const f=fixture(t),before=structuredClone(f.draft()),gate=f.blockRead(),pending=f.controller.prepare(),value=structuredClone(f.initial.value);
 if(mismatch==='source-reference')value.compositionRef.value=ref('other exact stored bytes','application/json');
 if(mismatch==='response-revision')value.revision='8';
 if(mismatch==='bindings')value.bindings={native:'unavailable'};
 if(mismatch==='linked-layer')value.layers[0].version='4';
 gate.resolve(value);await assert.rejects(pending);await flush();assert.deepEqual(f.draft(),before);assert.equal(f.applications.length,0);assert.equal(find(f.template(),'id="request-composition-text-preview"'),undefined);
});

test('an exact retained noncanonical JSON identity is preserved rather than recomputed from the parsed graph',async t=>{
 const f=fixture(t),reference=structuredClone(f.initial.reference);reference.value=ref(JSON.stringify(f.initial.value.composition,null,2),'application/json');f.editor.view.image.composition=reference;const gate=f.blockRead(),pending=f.controller.prepare(),value=structuredClone(f.initial.value);value.compositionRef=structuredClone(reference);gate.resolve(value);await pending;await flush();f.controller.accept();assert.deepEqual(f.applications[0].composition,reference);
});

for(const operation of ['cancel','dispose'])test(operation+' aborts the pending read and releases a late owned result',async t=>{
 const f=fixture(t),gate=f.blockRead(),pending=f.controller.prepare(),ending=f.controller[operation]();assert.equal(f.reads[0].options.signal.aborted,true);gate.resolve();await pending;await ending;await flush();assert.equal(f.applications.length,0);assert.equal(find(f.template(),'id="request-composition-text-preview"'),undefined);assert(f.holds.every(row=>row.released));
});

test('cancelling a rendered preview releases its draft pin while retaining owned preview bytes until render retires',async t=>{
 const f=fixture(t);await f.controller.prepare();await flush();const releaseRender=f.pauseRender();f.controller.cancel();await flush();assert(f.holds.every(row=>row.released),'The independent preview clone does not need to strand its source draft');assert(usage().promptBytes>modelPayloadBytes(f.draft()),'Rendered preview bytes remain owned');releaseRender();await flush();assert(f.holds.every(row=>row.released));assert.equal(find(f.template(),'id="request-composition-text-preview"'),undefined);assert.equal(f.applications.length,0);
});

test('failed preview retirement can retry during dispose without stranding the request entry',async t=>{
 const f=fixture(t);await f.controller.prepare();await flush();const render=f.pauseRender();f.controller.cancel();await flush();assert(f.holds.every(row=>row.released));render.fail(Error('RENDER_FAILURE'));await flush();await f.controller.dispose();await flush();assert.equal(find(f.template(),'id="request-composition-text-preview"'),undefined);assert(f.holds.every(row=>row.released));
});

test('a retained old confirmation callback cannot approve a later preview',async t=>{
 const f=fixture(t);await f.controller.prepare();await flush();const oldConfirm=f.callback('request-composition-text-confirm');assert.equal(typeof oldConfirm,'function');f.controller.cancel();await flush();await f.controller.prepare();await flush();try{await oldConfirm({});}catch(error){assert.match(error.message,/changed|preview/i);}assert.equal(f.applications.length,0,'Only the confirmation shown with this preview has authority');await f.click('request-composition-text-confirm');assert.equal(f.applications.length,1);
});

test('request admission refusal keeps the exact preview for a deliberate retry',async t=>{
 const f=fixture(t);await f.controller.prepare();await flush();const prompt=binding(find(f.template(),'id="request-composition-text-preview"'),'.value=');f.failApply(Error('ENTRY_ADMISSION_REFUSED'));assert.throws(()=>f.controller.accept(),/ENTRY_ADMISSION_REFUSED/);assert.equal(f.applications.length,0);await f.repaint();assert.equal(binding(find(f.template(),'id="request-composition-text-preview"'),'.value='),prompt);f.failApply(null);f.controller.accept();await flush();assert.equal(f.applications.length,1);assert.equal(f.applications[0].prompt,prompt);
});

// Synthetic input deliberately writes the current target, even when readonly.
// Only the controller may refuse persistence; the fixture does not filter it.
function nativeEvent(value='',extra={},control={value,isConnected:true}){control.value=value;return {currentTarget:control,composedPath:()=>[control],defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...extra};}
function integratedFixture(t){
 const baseline=usage(),source=approved(),saved=[],registrations=[],responses=[],commands=[];let flow,rendered,closed=false,native={value:'',readOnly:false,isConnected:false,updateComplete:Promise.resolve()};
 const ui=createOwnedModel('composition-text-integration-ui',1024,()=>({drafts:[]}));
 const own=value=>{const model=createOwnedModel('composition-text-integration-response',modelPayloadBytes(value),()=>structuredClone(value));responses.push(model);return model;};
 const response=value=>{const wire=JSON.stringify(value);return new Response(wire,{headers:{'content-length':String(Buffer.byteLength(wire))}});};
 const editor={documentEpoch:1,sessionId:'session',view:{ready:true,document:{id:'document',revision:'7',width:512,height:256},image:{width:512,height:256,layers:[],composition:structuredClone(source.reference)},selected:[]},ui:ui.value,
  draftOwner:{drafts:new Map(),refused:new Set(),refuseChange(id){this.refused.add(id);}},
  session:{identity:()=> 'client',async transport(path){if(path.endsWith('/request-reviews'))return response({items:[]});assert.equal(path,'/api/v1/documents/document/composition?revision=7');return response(source.value);}},
  registerDraft(id,documentId){const row={id,documentId,active:true};registrations.push(row);return ()=>{assert(row.active,'Draft registration releases once');row.active=false;};},
  pinUI(){return ui.pin();},pinViewModels(document,image){const model=own({document,image}),release=model.pin();model.release();return release;},
  ownedJSON(path,owner,init,owns,maxBytes,kind){return readOwnedJSON(this.session.transport.bind(this.session),path,{owner,init,owns,maxBytes,kind});},
  async ownedCommand(body){commands.push(structuredClone(body));return own([]);},async withCommandEvents(body,consume){const model=await this.ownedCommand(body);try{return await consume(model.value);}finally{model.release();}},
  changeDraft(id,kind,text,target,composing,revision){assert(registrations.some(row=>row.active&&row.id===id));const generation=String(saved.length+1);saved.push({id,kind,text,target,composing,revision,generation});this.draftOwner.drafts.set(id,{generation,savedGeneration:generation});this.draftOwner.refused.delete(id);},async flushDrafts(){},
  json(){assert.fail('Raw response API forbidden');},command(){assert.fail('No Composition export command should run');},requestReview(){assert.fail('Preview is not immutable request approval');},ownedRequestReview(){assert.fail('Export does not automatically prepare a request');}
 };
 // Preserve the mounted EnTextarea identity across renders; native ownership
 // retires only after removal or an admitted successor publishes its value.
 const host={updateComplete:Promise.resolve(),requestUpdate(){this.updateComplete=Promise.resolve().then(()=>{
  rendered=flow.render();const field=find(rendered,'<en-textarea id="prompt"');
  if(field){if(!native.isConnected)native={value:'',readOnly:false,isConnected:true,updateComplete:Promise.resolve()};const value=binding(field,'.value=');if(typeof value==='string')native.value=value;native.readOnly=binding(field,'?readOnly=');}
  else native.isConnected=false;
 });},querySelector(selector){return selector==='#prompt'?(native.isConnected?native:null):{focus(){}};}};
 flow=new RequestEditing(host,editor);
 const close=async()=>{if(closed)return;await flow.dispose();closed=true;await host.updateComplete;ui.release();await turn();assert.equal(native.isConnected,false,'Prompt control disconnects before its owned input retires');assert(registrations.every(row=>!row.active));for(const model of responses)assert.throws(()=>{const unpin=model.pin();unpin();},/MODEL_MEMORY_RELEASED/);assert.deepEqual(usage(),baseline);};t.after(close);
 return {flow,editor,source,saved,commands,close,get native(){return native;},template:()=>rendered,prompt:()=>find(rendered,'<en-textarea id="prompt"'),async initial(){await flow.sync();host.requestUpdate();await flush();},async select(operation){flow.operationChanged(labels[operations.indexOf(operation)]);await flush();},callback:id=>handler(rendered,id),async click(id){const callback=handler(rendered,id);assert.equal(typeof callback,'function',id);callback(nativeEvent());await turn();},async input(value){const event=nativeEvent(value,{},native);binding(this.prompt(),'@en-input=')(event);await turn();}};
}

test('integrated Composition origin is read-only until explicit detach; editing its copy preserves V4 and source provenance',async t=>{
 const f=integratedFixture(t);await f.initial();const v4=structuredClone(f.flow.entry().draft),source=structuredClone(f.source),native=f.native;await f.select('generate-v45');await turn();assert.equal(f.native,native,'The mounted prompt node is reused across request families');assert.equal(f.flow.inspectMemory().promptInput.retired,0,'The prior input owner retires through its admitted successor');const prior=f.flow.entry().text;
 await f.click('request-composition-text-prepare');assert.equal(f.flow.entry().text,prior);const exact=binding(find(f.template(),'id="request-composition-text-preview"'),'.value=');await f.click('request-composition-text-confirm');
 const attached=structuredClone(f.flow.entry().draft);assert.equal(f.flow.entry().text,exact);assert.equal(attached.prompt.mode,'plain');assert.equal(attached.prompt.projection.serializer,'composition-text-1');assert.deepEqual(attached.prompt.composition,source.reference);assert.equal(binding(f.prompt(),'?readOnly='),true);assert.equal(f.native.value,exact);assert.equal(f.native.readOnly,true);assert.deepEqual(f.commands,[]);
 const saved=f.saved.length,before=nativeEvent(exact,{cancelable:true,inputType:'insertText',data:'unexpected'},f.native);binding(f.prompt(),'@beforeinput=')(before);assert.equal(before.defaultPrevented,true,'Origin text must reject native edits before admission');await f.input('Synthetic input must not rewrite an approved brief');assert.equal(f.saved.length,saved);assert.deepEqual(f.flow.entry().draft,attached);assert.equal(f.flow.entry().text,exact);assert.equal(f.flow.inspectMemory().promptInput.refused,false);
 await f.click('request-composition-text-detach');assert.equal(binding(f.prompt(),'?readOnly='),false);assert.equal(f.flow.entry().text,exact);assert.equal(f.flow.entry().draft.prompt.projection,null);assert.equal(f.flow.entry().draft.prompt.composition,null);await f.input('An independently edited brief');assert.equal(f.native.value,'An independently edited brief');assert.equal(f.native.readOnly,false);assert.equal(f.flow.entry().text,'An independently edited brief');assert.equal(f.flow.entry().draft.prompt.projection,null);assert.deepEqual(f.source,source);await f.select('generate');assert.deepEqual(f.flow.entry().draft,v4);
});

test('returning from raw mode preserves the retained reviewed plain brief and its explicit detach requirement',async t=>{
 const f=integratedFixture(t);await f.initial();await f.select('generate-v45');await f.click('request-composition-text-prepare');await f.click('request-composition-text-confirm');const retained=structuredClone(f.flow.entry().draft.prompt);
 f.flow.modeChanged('raw');await flush();assert.equal(f.flow.entry().draft.prompt.mode,'raw');assert.equal(f.flow.entry().draft.prompt.projection,null);f.flow.modeChanged('plain');await flush();assert.deepEqual(f.flow.entry().draft.prompt,retained);assert.equal(binding(f.prompt(),'?readOnly='),true);
});

test('a late native veto cannot detach the reviewed Composition origin',async t=>{
 const f=integratedFixture(t);await f.initial();await f.select('generate-v45');await f.click('request-composition-text-prepare');await f.click('request-composition-text-confirm');const prior=structuredClone(f.flow.entry().draft),saved=f.saved.length,event=nativeEvent();f.callback('request-composition-text-detach')(event);event.preventDefault();await turn();assert.deepEqual(f.flow.entry().draft,prior);assert.equal(f.saved.length,saved);assert.equal(binding(f.prompt(),'?readOnly='),true);
});

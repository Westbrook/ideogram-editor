import test from 'node:test';
import assert from 'node:assert/strict';
import {bindRequestMask} from '../../dist/local/src/request/core.js';
import {RequestEditing,allocationLedger,createOwnedModel,modelPayloadBytes,readOwnedJSON} from './request-controller-module.mjs';

// Only the DOM/Lit surface is represented here. The shared controller loader
// uses the actual request, ownership, keyboard, review and queue implementations.
class ElementFixture {
 constructor(tag='div',attributes={},document={activeElement:null}){this.tagName=tag.toUpperCase();this.attributes=attributes;this.id=attributes.id??'';this.ownerDocument=document;this.isConnected=true;this.hidden=false;this.inert=false;this.isContentEditable=false;this.focuses=0;}
 getAttribute(name){return this.attributes[name]??null;}
 getRootNode(){return this.root??this.ownerDocument;}
 matches(selectors){return selectors.split(',').some(selector=>{selector=selector.trim();if(selector==='[contenteditable]:not([contenteditable="false"])')return this.attributes.contenteditable!==undefined&&this.attributes.contenteditable!=='false';if(selector==='a[href]')return this.tagName==='A'&&this.attributes.href!==undefined;const role=/^\[role="([^"]+)"\]$/.exec(selector);return role?this.attributes.role===role[1]:this.tagName===selector.toUpperCase();});}
 focus(){this.ownerDocument.activeElement=this;this.focuses++;}
}
const previousHTMLElement=globalThis.HTMLElement;globalThis.HTMLElement=ElementFixture;
test.after(()=>{if(previousHTMLElement===undefined)delete globalThis.HTMLElement;else globalThis.HTMLElement=previousHTMLElement;});
const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
const turn=async()=>{await new Promise(resolve=>setTimeout(resolve,5));await flush();};
const usage=()=>{const s=allocationLedger.snapshot();return {cpuBytes:s.cpuBytes,promptBytes:s.promptBytes,handles:s.handles,activeRecords:s.activeRecords};};
function find(template,marker){if(!template||typeof template!=='object')return;if(template.strings){const index=template.strings.findIndex(value=>value.includes(marker));if(index>=0)return {strings:template.strings.slice(index),values:template.values.slice(index)};}for(const value of Array.isArray(template)?template:template.values??[]){const found=find(value,marker);if(found)return found;}}
function handler(template,marker,event='@click='){const found=find(template,marker);assert(found,'Rendered '+marker);const index=found.strings.findIndex(value=>value.includes(event));assert(index>=0,'Rendered '+event+' on '+marker);assert.equal(typeof found.values[index],'function');return found.values[index];}
function markup(template){if(template===null||template===undefined)return '';if(Array.isArray(template))return template.map(markup).join('');if(template?.strings)return template.strings.reduce((result,text,index)=>result+text+(index<template.values.length?markup(template.values[index]):''),'');return typeof template==='function'?'HANDLER':typeof template==='object'?'VALUE':String(template);}
function actionEvent(node){return {currentTarget:node,composedPath:()=>[node],defaultPrevented:false};}
function control(template,id){
 if(!template||typeof template!=='object')return;
 if(template.strings){const index=template.strings.findIndex((part,index)=>part.includes('id="'+id+'"')||part.endsWith('id=')&&template.values[index]===id);if(index>=0)return {strings:template.strings.slice(index),values:template.values.slice(index)};}
 for(const value of Array.isArray(template)?template:template.values??[]){const found=control(value,id);if(found)return found;}
}
function controlProperty(template,id,property){const found=control(template,id);assert(found,'Rendered control '+id);const index=found.strings.findIndex(part=>part.includes(property+'='));assert(index>=0,'Rendered '+property+' on '+id);return found.values[index];}
const previousCSS=globalThis.CSS;globalThis.CSS={...previousCSS,escape(value){assert.match(value,/^[a-z-]+$/);return value;}};
test.after(()=>{if(previousCSS===undefined)delete globalThis.CSS;else globalThis.CSS=previousCSS;});

async function fixture(t,{historical=[]}={}){
 const baseline=usage(),models=new Set(),registrations=new Map(),saved=[],reviews=[],commands=[],dom={activeElement:null},modals=[];let flow,rendered,identity='client',closed=false;
 const own=(value,owner='shortcut-fixture')=>{const model=createOwnedModel(owner,modelPayloadBytes(value),()=>structuredClone(value));models.add(model);return model;};
 const ui=own({drafts:[]}),prompt=new ElementFixture('en-textarea',{},dom);Object.assign(prompt,{value:'',updateComplete:Promise.resolve()});
 const region=new ElementFixture('div',{'data-request-shortcut-scope':'',tabindex:'0'},dom),reviewRegion=new ElementFixture('en-card',{id:'request-review','data-request-shortcut-scope':'',tabindex:'0'},dom),errors=new ElementFixture('div',{id:'request-errors'},dom);
 const draftOwner={drafts:new Map(),refused:new Map(),get hasRefusedChanges(){return this.refused.size>0;},refuseChange(id,documentId){assert(registrations.has(id));this.refused.set(id,documentId);}};
 const queue={session:{id:'spend',version:'1',cap:null},counts:{reserved:0,dispatched:0,remaining:null,active:0},jobs:[],nextCursor:null,totalJobs:0};
 const editor={documentEpoch:1,view:{ready:true,document:{id:'doc',revision:'1'},image:{layers:[]},selected:[]},sessionId:'session',session:{identity:()=>identity},draftOwner,ui:ui.value,
  registerDraft(id,documentId){assert.equal(documentId,'doc');registrations.set(id,(registrations.get(id)??0)+1);let live=true;return ()=>{if(!live)return;live=false;const count=registrations.get(id)-1;if(count)registrations.set(id,count);else registrations.delete(id);};},
  pinUI(){return ui.pin();},pinViewModels(document,image){const model=own({document,image});const release=model.pin();model.release();return release;},
  changeDraft(id,kind,text,target,composing,revision){saved.push({id,kind,text,target,composing,revision});this.draftOwner.drafts.set(id,{generation:String(saved.length),savedGeneration:null});this.draftOwner.refused?.delete(id);},
  async flushDrafts(){for(const row of this.draftOwner.drafts.values())row.savedGeneration=row.generation;},
  async json(path){return path.startsWith('/api/v1/queue')?queue:{items:historical};},
  async ownedJSON(path,owner,init,current=()=>true,maxBytes=1024**2,kind='control'){const result=await readOwnedJSON(async()=>{const wire=JSON.stringify(await this.json(path));return new Response(wire,{headers:{'content-length':String(Buffer.byteLength(wire))}});},path,{owner,init,owns:current,maxBytes,kind});models.add(result);return result;},
  async ownedRequestReview(body){reviews.push(structuredClone(body));return own(body.type==='PrepareRequestReview'?{review:{id:'review-'+reviews.length,token:'exact-token',endpoint:'ideogram/v4',request:{kind:'generate'},prompt:{hash:'sha256:'+('1'.repeat(64)),byteLength:'12'},estimate:{unknown:[]}}}:{acceptedReview:body.reviewId,requestId:'acceptance-exact'});},
  async withCommandEvents(body,consume,document){assert.equal(document,null);commands.push(structuredClone(body));const model=own([{type:'JobQueued'}]);try{return await consume(model.value);}finally{model.release();}},
 };
 const controls=new Map(),foreignControls=new Map(),typedRequest=new ElementFixture('section',{class:'typed-request'},dom);
 const ownedControl=selector=>selector==='#prompt'?(prompt.isConnected?prompt:null):selector==='#request-review'?reviewRegion:selector==='#request-errors'?errors:controls.get(selector.slice(1))??null;
 typedRequest.querySelector=ownedControl;
 const host=new ElementFixture('ideogram-editor',{},dom);Object.assign(host,{updateComplete:Promise.resolve(),querySelectorAll(){return modals;},querySelector(selector){return selector==='.typed-request'?(typedRequest.isConnected?typedRequest:null):foreignControls.get(selector.slice(1))??ownedControl(selector);},requestUpdate(){this.updateComplete=Promise.resolve().then(()=>{rendered=flow.render();const field=find(rendered,'<en-textarea id="prompt"');prompt.isConnected=!!field;if(field){const index=field.strings.findIndex(part=>part.includes('.value='));const value=field.values[index];if(typeof value==='string')prompt.value=value;}});}});
 flow=new RequestEditing(host,editor);
 const stopPoll=()=>{if(flow.pollTimer)clearTimeout(flow.pollTimer);flow.pollTimer=null;};
 t.after(async()=>{if(closed)return;closed=true;stopPoll();await flow.dispose();await turn();assert.equal(registrations.size,0,'Draft registrations released');ui.release();for(const model of models)assert.throws(()=>model.pin(),/MODEL_MEMORY_RELEASED/);assert.deepEqual(usage(),baseline,'Controller ownership is released');});
 await flow.sync();host.requestUpdate();await flush();
 const type=async(value)=>{prompt.value=value;handler(rendered,'<en-textarea id="prompt"','@en-input=')(actionEvent(prompt));await flush();};
 await type('Paint a bluebird.');region.focus();
 const keyboard=(options={})=>{
  const scope=options.scope??region,target=options.target??scope,path=options.path??[target,...(target===scope?[]:[scope]),host];
  for(let index=0;index+1<path.length;index++)path[index].parentElement=path[index+1];
  if(options.focus!==false)target.focus();let dispatch=true;
  const event={currentTarget:scope,key:'Enter',ctrlKey:true,metaKey:false,altKey:false,shiftKey:false,repeat:false,isComposing:false,keyCode:13,defaultPrevented:false,...options.flags,composedPath:()=>dispatch?path:[],preventDefault(){this.defaultPrevented=true;}};
  const callback=options.callback??handler(rendered,scope===reviewRegion?'<en-card id="request-review"':'<div data-request-shortcut-scope','@keydown=');
  callback(event);dispatch=false;event.currentTarget=null;return event;
 };
 return {flow,editor,host,dom,modals,region,reviewRegion,prompt,reviews,commands,saved,type,keyboard,errors,controls,foreignControls,typedRequest,async input(id,value,event='@en-input'){let node=controls.get(id);if(!node){node=new ElementFixture(id==='request-seed'?'en-text-field':['request-size','request-dimensions'].includes(id)?'en-select':'en-number-field',{id},dom);controls.set(id,node);}node.value=value;controlProperty(rendered,id,event)(actionEvent(node));await flush();return node;},summary(target,callback=handler(rendered,'<en-validation-summary id="request-errors"','@en-action=')){const event={detail:{data:{target}},defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};callback(event);return event;},render:()=>rendered,stopPoll,identity(value){identity=value;},async click(id){const node=new ElementFixture('en-button',{id},dom);handler(rendered,'<en-button id="'+id+'"')(actionEvent(node));await turn();},composition(start){handler(rendered,'<section aria-label="Typed request draft"',start?'@compositionstart=':'@compositionend=')();}};
}

for(const modifier of ['ctrlKey','metaKey'])test(modifier+' Enter prepares, focuses an unaccepted review, then queues only the explicitly accepted exact review',async t=>{
 const f=await fixture(t),flags={ctrlKey:false,metaKey:false,[modifier]:true};
 f.keyboard({flags});await turn();assert.equal(f.reviews.length,1);assert.equal(f.reviews[0].type,'PrepareRequestReview');assert.deepEqual(f.commands,[]);assert.equal(f.flow.accepted,false);
 const focused=f.reviewRegion.focuses;f.keyboard({scope:f.reviewRegion,flags});await turn();assert.equal(f.reviews.length,1,'An unaccepted review is only focused');assert(f.reviewRegion.focuses>focused);assert.deepEqual(f.commands,[]);
 await f.click('accept-request');assert.equal(f.reviews[1].type,'AcceptRequestReview');assert.deepEqual(f.commands,[],'Explicit local acceptance does not enqueue');
 const exact=f.flow.review;f.keyboard({scope:f.reviewRegion,flags});await turn();f.stopPoll();assert.deepEqual(f.commands,[{type:'QueueInference',reviewId:exact.id,token:exact.token,acceptanceId:'acceptance-exact'}]);assert.equal(f.reviews.length,2,'Shortcut never performs implicit acceptance');
});

test('only authored draft and immutable review regions have listeners; retained queue and candidate history remain outside',async t=>{
 const f=await fixture(t,{historical:[{review:{id:'retained-review',token:'historical-token',endpoint:'ideogram/v4',documentId:'doc'},accepted:true}]});f.keyboard();await turn();const html=markup(f.render()),start=html.indexOf('<div data-request-shortcut-scope'),end=html.indexOf('</div>',start),retained=html.indexOf('label="Retained request reviews"'),history=html.indexOf('id="request-candidate-history"'),queue=html.indexOf('id="durable-queue"'),review=html.indexOf('id="request-review"');
 assert(start>=0&&end>start&&retained>end&&history>retained&&queue>history&&review>queue);assert.equal((html.match(/@keydown=HANDLER/g)??[]).length,2);assert.match(html.slice(start,end),/tabindex="0"/);assert.match(html.slice(start,end),/Cmd\/Ctrl\+Enter/);assert.match(html.slice(start,end),/aria-keyshortcuts="Control\+Enter Meta\+Enter"/);assert.match(html.slice(review),/aria-keyshortcuts="Control\+Enter Meta\+Enter"/);
 const outside=new ElementFixture('div',{},f.dom);f.keyboard({path:[outside,f.host],target:outside});await turn();assert.equal(f.reviews.length,1);assert.deepEqual(f.commands,[]);
});

test('fields, composition, activation widgets, modifier conflicts and already handled keys keep their existing behavior',async t=>{
 const f=await fixture(t);
 for(const [tag,attributes] of [['input',{}],['textarea',{}],['select',{}],['en-text-field',{}],['en-textarea',{}],['en-number-field',{}],['en-select',{}],['en-slider',{}],['div',{contenteditable:'true'}],['div',{role:'textbox'}],['button',{}],['en-button',{}],['a',{href:'/'}],['en-link',{}],['div',{role:'button'}],['div',{role:'tab'}],['div',{role:'switch'}]]){const target=new ElementFixture(tag,attributes,f.dom);const event=f.keyboard({target});await turn();assert.equal(event.defaultPrevented,false,tag+' retains its native key');}
 for(const flags of [{ctrlKey:false},{metaKey:true},{altKey:true},{shiftKey:true},{key:'Escape'},{repeat:true},{isComposing:true},{keyCode:229},{defaultPrevented:true}]){f.keyboard({flags});await turn();}
 f.composition(true);f.keyboard();await turn();f.composition(false);await flush();assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);
});

test('actual focused shadow input suppresses the shortcut; focus in an unrelated region cannot borrow a request path',async t=>{
 const f=await fixture(t),field=new ElementFixture('en-textarea',{},f.dom),native=new ElementFixture('textarea',{},f.dom);field.shadowRoot={activeElement:native};f.dom.activeElement=field;
 f.keyboard({target:native,path:[native,field,f.region,f.host],focus:false});await turn();
 f.dom.activeElement=new ElementFixture('div',{},f.dom);f.keyboard({focus:false});await turn();assert.deepEqual(f.reviews,[]);
});

test('request drawer is allowed only on the focused path; other open modal surfaces block actions',async t=>{
 const f=await fixture(t),drawer=new ElementFixture('en-drawer',{id:'request-drawer'},f.dom);drawer.open=true;f.modals.push(drawer);
 f.keyboard();await turn();assert.deepEqual(f.reviews,[]);
 f.keyboard({path:[f.region,drawer,f.host]});await turn();assert.equal(f.reviews.length,1);
 const modal=new ElementFixture('en-dialog',{},f.dom);modal.open=true;f.modals.push(modal);const before=f.reviewRegion.focuses;f.keyboard({scope:f.reviewRegion,path:[f.reviewRegion,drawer,f.host]});await turn();assert.equal(f.reviewRegion.focuses,before+1,'Only explicit fixture focus occurred; shortcut was suppressed');assert.equal(f.reviews.length,1);assert.deepEqual(f.commands,[]);
});

for(const change of ['veto','detach','focus','modal','activation','document','revision','session','identity','owner','operation'])test('deferred keyboard action refuses '+change+' before dispatch settles',async t=>{
 const f=await fixture(t),event=f.keyboard();
 if(change==='veto')event.preventDefault();if(change==='detach')f.region.isConnected=false;if(change==='focus')f.dom.activeElement=new ElementFixture('div',{},f.dom);if(change==='modal'){const node=new ElementFixture('dialog',{},f.dom);node.open=true;f.modals.push(node);}if(change==='activation')f.region.attributes.role='button';if(change==='document')f.editor.view.document={id:'other',revision:'1'};if(change==='revision')f.editor.view.document={id:'doc',revision:'2'};if(change==='session')f.editor.sessionId='other';if(change==='identity')f.identity('other');if(change==='owner')f.editor.draftOwner={drafts:new Map()};if(change==='operation')f.flow.operationChanged('Generate with Fast');
 await turn();assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);
});

test('busy, refused prompt and unavailable document do not start review; a changed review cannot enqueue through a delayed shortcut',async t=>{
 const f=await fixture(t);
 for(const field of ['busy','queueBusy']){f.flow[field]=true;f.keyboard();await turn();f.flow[field]=false;}
 f.flow.promptInput.refused=true;f.keyboard();await turn();f.flow.promptInput.refused=false;
 f.editor.view.ready=false;f.keyboard();await turn();f.editor.view.ready=true;assert.deepEqual(f.reviews,[]);
 f.keyboard();await turn();await f.click('accept-request');f.keyboard({scope:f.reviewRegion});f.flow.acceptanceId='replacement-acceptance';await turn();assert.deepEqual(f.commands,[]);assert.equal(f.reviews.length,2);
});

test('a request edited while its real saved-draft prerequisite waits cannot publish or enqueue a stale review',async t=>{
 const f=await fixture(t);let release,started;const waiting=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);f.editor.flushDrafts=async()=>{started();await gate;for(const row of f.editor.draftOwner.drafts.values())row.savedGeneration=row.generation;};
 try{f.keyboard();await waiting;await f.type('A different request.');release();await turn();assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);}finally{release();}
});

for(const [field,value,code,repair] of [['count','0','COUNT','1'],['count','','COUNT','1'],['seed','1.5','SEED','900719925474099312345'],['width','','SIZE','1024'],['height','900','SIZE','896']])test('strict '+field+' error retains raw '+JSON.stringify(value)+' with an inline error and focused summary link',async t=>{
 const f=await fixture(t),id='request-'+field,node=await f.input(id,value);await f.click('prepare-request');
 assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);assert.equal(f.flow.entry().draft.fields[field],value);assert.equal(JSON.parse(f.saved.at(-1).text).draft.fields[field],value);assert.equal(node.value,value);assert.equal(controlProperty(f.render(),id,'.value'),value);assert.match(controlProperty(f.render(),id,'.error'),new RegExp(code));assert(f.errors.focuses>0);
 const item=f.flow.issueItems.find(item=>item.target===id);assert(item,'Summary links the offending field');const stale=handler(f.render(),'<en-validation-summary id="request-errors"','@en-action=');f.summary(id);assert.equal(f.dom.activeElement,node);
 if(field==='height')assert.equal(controlProperty(f.render(),'request-width','.error'),'','A valid other dimension is not blamed');
 await f.input(id,repair);assert.equal(controlProperty(f.render(),id,'.error'),'');assert.deepEqual(f.flow.issueItems,[]);const before=node.focuses;f.summary(id,stale);assert.equal(node.focuses,before,'Cleared issues cannot move focus');
 await f.click('prepare-request');assert.equal(f.reviews.length,1,'Only the corrected exact request reaches review');assert.deepEqual(f.commands,[]);
});

function installEditSource(f){
 const ref=(number,mediaType='application/json',byteLength='32')=>({hash:'sha256:'+number.toString(16).padStart(64,'0'),byteLength,mediaType});
 const source={assetId:'source',version:'1',blob:ref(1,'image/png'),pixels:ref(2,'application/x-ideogram-rgba8','64'),width:8,height:2,scope:'single-layer',documentRevision:'1',capture:ref(3)},raster={blob:ref(4,'image/png'),pixels:source.pixels,manifest:ref(5),pixelIdentity:ref(6).hash,width:8,height:2},preparedInputs={assetId:'inputs',version:'1',manifest:raster.manifest,source:raster,mask:null,references:[]};
 // Explicit synthetic retained descriptors; no upload, source capture or eligibility is simulated.
 f.flow.mutateEntry({source,preparedInputs},next=>{next.draft.source=source;if(next.draft.kind==='request-draft-v45-1')next.draft.preparedInputs=preparedInputs;});
}

test('transformation strength preserves empty, nonfinite and out-of-range drafts; exact zero remains valid',async t=>{
 const f=await fixture(t);f.flow.operationChanged('Transform image');installEditSource(f);await flush();await f.input('request-size','auto','@en-change');
 for(const value of ['', 'NaN', 'Infinity', '-0.1', '1.01']){const node=await f.input('request-strength',value);await f.click('prepare-request');assert.equal(f.flow.entry().draft.fields.strength,value);assert.equal(node.value,value);assert.match(controlProperty(f.render(),'request-strength','.error'),/STRENGTH/);f.summary('request-strength');assert.equal(f.dom.activeElement,node);assert.deepEqual(f.reviews,[]);}
 // NaN/Infinity above are saved/controller drafts: native number inputs cannot type those spellings.
 await f.input('request-strength','0');assert.equal(controlProperty(f.render(),'request-strength','.error'),'');await f.click('prepare-request');assert.equal(f.reviews.length,1);assert.equal(f.flow.entry().draft.fields.strength,'0');assert.deepEqual(f.commands,[]);
});

test('an aggregate V4 area issue links both editable dimensions without changing either one',async t=>{
 const f=await fixture(t);f.flow.operationChanged('Transform image');installEditSource(f);await flush();await f.input('request-strength','0');await f.input('request-width','6000');await f.input('request-height','6000');await f.click('prepare-request');
 const targets=f.flow.issueItems.filter(item=>item.message.includes('SIZE:')).map(item=>item.target);assert.deepEqual(targets,['request-width','request-height']);for(const field of ['width','height']){assert.equal(f.flow.entry().draft.fields[field],'6000');assert.match(controlProperty(f.render(),'request-'+field,'.error'),/SIZE/);}assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);
});

for(const operation of ['Generate with Ideogram v4.5','Transform with Ideogram v4.5'])test(operation+' uses the same scalar error and stale-focus boundaries',async t=>{
 const f=await fixture(t);f.flow.operationChanged(operation);if(operation.startsWith('Transform'))installEditSource(f);await flush();
 for(const [field,value,code,repair] of [['count','5','V45_APP_COUNT','1'],['seed','01','V45_SEED','-900719925474099312345']]){const id='request-'+field,node=await f.input(id,value);await f.click('prepare-request');assert.equal(f.flow.entry().draft.fields[field],value);assert.match(controlProperty(f.render(),id,'.error'),new RegExp(code));assert(f.flow.issueItems.some(item=>item.target===id));f.summary(id);assert.equal(f.dom.activeElement,node);assert.deepEqual(f.reviews,[]);await f.input(id,repair);assert.equal(controlProperty(f.render(),id,'.error'),'');}
 await f.click('prepare-request');assert.equal(f.reviews.length,1);assert.deepEqual(f.commands,[]);
});

test('v4.5 generation saved custom-size errors focus the exact-size selector',async t=>{
 const f=await fixture(t);f.flow.operationChanged('Generate with Ideogram v4.5');f.flow.mutateEntry(undefined,next=>Object.assign(next.draft.fields,{size:'custom',width:'1025',height:'1024'}));await flush();const dimensions=new ElementFixture('en-select',{id:'request-dimensions'},f.dom);f.controls.set(dimensions.id,dimensions);await f.click('prepare-request');
 assert.match(controlProperty(f.render(),dimensions.id,'.error'),/V45_SIZE/);assert.equal(controlProperty(f.render(),'request-size','.error'),'');assert.deepEqual(f.flow.issueItems.map(item=>item.target),['request-dimensions']);f.summary(dimensions.id);assert.equal(f.dom.activeElement,dimensions);assert.equal(f.flow.entry().draft.fields.width,'1025');assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);
});

test('v4.5 unmasked custom dimensions distinguish an invalid axis from pair constraints',async t=>{
 const f=await fixture(t);f.flow.operationChanged('Transform with Ideogram v4.5');installEditSource(f);await flush();await f.input('request-size','custom','@en-change');await f.input('request-height','900');await f.click('prepare-request');assert.deepEqual(f.flow.issueItems.map(item=>item.target),['request-height']);assert.match(controlProperty(f.render(),'request-height','.error'),/V45_EDIT_SIZE/);assert.equal(controlProperty(f.render(),'request-width','.error'),'');
 await f.input('request-height','4096');await f.input('request-width','4096');await f.click('prepare-request');assert.deepEqual(f.flow.issueItems.map(item=>item.target),['request-width','request-height']);assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);
});

for(const change of ['field','operation','document','identity'])test('queued validation focus and old summary actions are canceled by '+change,async t=>{
 const f=await fixture(t),node=await f.input('request-count','0');await f.click('prepare-request');const stale=handler(f.render(),'<en-validation-summary id="request-errors"','@en-action='),before=f.errors.focuses;let finish;const gate=new Promise(resolve=>finish=resolve),update=f.host.requestUpdate;f.host.requestUpdate=function(){this.updateComplete=gate;};
 try{f.flow.error(new Error('Pending validation action'));if(change==='field')f.flow.mutateEntry(undefined,next=>{next.draft.fields.count='1';});if(change==='operation')f.flow.operationChanged('Generate with Fast');if(change==='document')f.editor.view.document={id:'other',revision:'1'};if(change==='identity')f.identity('other');finish();await flush();const focused=node.focuses;f.summary('request-count',stale);assert.equal(node.focuses,focused);assert.equal(f.errors.focuses,before);assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);}finally{f.host.requestUpdate=update;finish?.();f.host.requestUpdate();await flush();}
});

test('actual masked transport mapping errors reach inline controls and current summary links, then clear on correction',async t=>{
 const f=await fixture(t);f.flow.operationChanged('Edit masked region with Ideogram v4.5');await f.flow.requestEdits.sync();installEditSource(f);const source=f.flow.entry().draft.source,ref=(number,mediaType='application/json',byteLength='32')=>({hash:'sha256:'+number.toString(16).padStart(64,'0'),byteLength,mediaType});
 const mask={assetId:'mask',version:'1',blob:ref(7,'image/png'),pixels:ref(8,'application/x-ideogram-rgba8','64'),width:8,height:2,sourceHash:source.pixels.hash,polarity:'white-edit',empty:false,full:false,fullAcknowledged:false,cropAcknowledged:false,plan:ref(9),binding:bindRequestMask(source)},manifest={plan:{hard:ref(10,'application/x-ideogram-r16le','32'),effective:ref(11,'application/x-ideogram-r16le','32')}};
 f.flow.mutateEntry(mask,next=>{next.draft.mask=mask;next.draft.preparedInputs=null;next.draft.fields.width=next.draft.fields.height='128';});const edits=f.flow.requestEdits;edits.geometry={x:'0',y:'0',width:'8',height:'2',left:'0',top:'0',right:'0',bottom:'0'};f.editor.beginFeedback=()=>{};await flush();
 // Use the real RequestEdits action/error hook and mappingPlan; only source/mask descriptors are synthetic.
 const mapping=async()=>{let plan;const node=new ElementFixture('en-button',{},f.dom);edits.action(actionEvent(node),()=>{plan=edits.mappingPlan(f.flow.entry().draft.mask,manifest,'already-contained');});await turn();return plan;};
 const original=structuredClone({source:f.flow.entry().draft.source,mask:f.flow.entry().draft.mask});
 for(const [field,value] of [['width',''],['height','8193']]){const id='request-'+field,node=await f.input(id,value);assert.equal(await mapping(),undefined);assert.equal(f.flow.entry().draft.fields[field],value);assert.equal(JSON.parse(f.saved.at(-1).text).draft.fields[field],value);assert.match(controlProperty(f.render(),id,'.error'),/REQUEST_GRID_SIZE/);assert.deepEqual(f.flow.issueItems.map(item=>item.target),[id]);assert(f.errors.focuses>0);f.summary(id);assert.equal(f.dom.activeElement,node);assert.deepEqual({source:f.flow.entry().draft.source,mask:f.flow.entry().draft.mask},original);assert.equal(edits.mapping,null);assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);const stale=handler(f.render(),'<en-validation-summary id="request-errors"','@en-action=');await f.input(id,'128');assert.equal(controlProperty(f.render(),id,'.error'),'');const focused=node.focuses;f.summary(id,stale);assert.equal(node.focuses,focused);}
 const plan=await mapping();assert.deepEqual(plan.requestGrid,{width:128,height:128});assert.deepEqual(plan.sourcePixels,source.pixels);assert.deepEqual(plan.effectiveMask,manifest.plan.effective);assert.deepEqual(f.flow.issueItems,[]);assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);
});

for(const scenario of [
 {name:'four distinct versions',code:'ADAPTER_COUNT',target:'request-adapter-count',removeIndex:3,inline:'request-adapter-count-error',versions:[1,2,3,4],scales:['0','1.00','0.00','1']},
 {name:'a repeated exact version',code:'DUPLICATE_ADAPTER',target:'request-adapter-duplicates',removeIndex:1,inline:'request-adapter-duplicate-1',versions:[1,1,2],scales:['0','1.00','0.00']},
])test('restored attachments with '+scenario.name+' reveal the exact removal control and preserve the remaining draft',async t=>{
 const f=await fixture(t),attachments=scenario.versions.map((version,index)=>({version:'restored-'+version,hash:'sha256:'+String(version).repeat(64),scale:scenario.scales[index]}));
 // These retained descriptors remain unavailable: the fixture supplies no eligible library entries.
 f.flow.operationChanged('Generate with adapters');f.flow.mutateEntry(attachments,next=>{next.draft.adapters=structuredClone(attachments);});await flush();
 const opened=[],accordion=new ElementFixture('en-accordion-item',{id:'request-adapters'},f.dom),removeId='request-adapter-remove-'+scenario.removeIndex,remove=new ElementFixture('en-button',{id:removeId},f.dom);
 Object.assign(accordion,{open:false,updateComplete:Promise.resolve(),requestOpen(open){opened.push(open);this.open=open;return 'committed';}});f.controls.set(accordion.id,accordion);f.controls.set(remove.id,remove);
 await f.click('prepare-request');assert(f.flow.issueItems.some(item=>item.target===scenario.target&&item.message.startsWith(scenario.code+':')));assert(f.flow.issueItems.some(item=>item.message.startsWith('ADAPTER_UNAVAILABLE:')));assert(f.errors.focuses>0);assert(control(f.render(),scenario.inline));assert.equal(accordion.open,false);
 assert.deepEqual(f.flow.entry().draft.adapters,attachments);assert.deepEqual(JSON.parse(f.saved.at(-1).text).draft.adapters,attachments);assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);
 const stale=handler(f.render(),'<en-validation-summary id="request-errors"','@en-action=');assert.equal(f.summary(scenario.target).defaultPrevented,true);await flush();assert.deepEqual(opened,[true]);assert.equal(accordion.open,true);assert.equal(f.dom.activeElement,remove);assert.equal(remove.focuses,1);
 assert.equal(controlProperty(f.render(),removeId,'?disabled'),false);controlProperty(f.render(),removeId,'@click')(actionEvent(remove));await turn();
 const remaining=attachments.filter((_,index)=>index!==scenario.removeIndex);assert.deepEqual(f.flow.entry().draft.adapters,remaining,'Removal preserves order, exact hashes and raw scales');assert.deepEqual(JSON.parse(f.saved.at(-1).text).draft.adapters,remaining);assert.deepEqual(f.flow.issueItems,[]);assert.equal(control(f.render(),scenario.inline),undefined);
 remaining.forEach((attachment,index)=>assert.equal(controlProperty(f.render(),'request-adapter-scale-'+index,'.value'),attachment.scale));assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);
 accordion.open=false;const focused=remove.focuses;f.summary(scenario.target,stale);await flush();assert.equal(accordion.open,false);assert.deepEqual(opened,[true]);assert.equal(remove.focuses,focused,'A corrected summary cannot reveal or focus the former removal control');
 await f.click('prepare-request');assert(!f.flow.issueItems.some(item=>item.message.startsWith(scenario.code+':')));assert(f.flow.issueItems.some(item=>item.message.startsWith('ADAPTER_UNAVAILABLE:')),'Structural correction does not grant local eligibility');assert.equal(control(f.render(),scenario.inline),undefined);assert.deepEqual(f.flow.entry().draft.adapters,remaining);assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);
});

for(const field of ['width','height','dimensions'])test('validation focus stays in the typed request with an earlier foreign '+field+' control',async t=>{
 const f=await fixture(t),id='request-'+field;
 if(field==='dimensions'){f.flow.operationChanged('Generate with Ideogram v4.5');f.flow.mutateEntry(undefined,next=>Object.assign(next.draft.fields,{size:'custom',width:'1025',height:'1024'}));await flush();f.controls.set(id,new ElementFixture('en-select',{id},f.dom));}
 else await f.input(id,field==='width'?'':'900');
 const node=f.controls.get(id),foreign=new ElementFixture(field==='dimensions'?'en-select':'en-number-field',{id},f.dom);foreign.hidden=true;f.foreignControls.set(id,foreign);
 assert.equal(f.host.querySelector('#'+id),foreign,'The earlier hidden Composition field wins a host-wide lookup');assert.equal(f.typedRequest.querySelector('#'+id),node);
 await f.click('prepare-request');assert(f.flow.issueItems.some(item=>item.target===id));assert.equal(f.dom.activeElement,f.errors);
 assert.equal(f.summary(id).defaultPrevented,true);assert.equal(f.dom.activeElement,node);assert.equal(node.focuses,1);assert.equal(foreign.focuses,0);assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);
});

for(const missing of ['region','control','issue'])test('validation focus does not fall back to a foreign target when the owned '+missing+' is absent',async t=>{
 const f=await fixture(t),id='request-width',node=await f.input(id,'');await f.click('prepare-request');const foreign=new ElementFixture('en-number-field',{id},f.dom);f.foreignControls.set(id,foreign);
 if(missing==='region')f.typedRequest.isConnected=false;else if(missing==='control')f.controls.delete(id);
 const target=missing==='issue'?'request-height':id;if(missing==='issue'){foreign.id=target;f.foreignControls.set(target,foreign);f.controls.set(target,new ElementFixture('en-number-field',{id:target},f.dom));}
 assert.equal(f.host.querySelector('#'+target),foreign);const before=f.dom.activeElement;assert.equal(f.summary(target).defaultPrevented,true);assert.equal(f.dom.activeElement,before);assert.equal(node.focuses,0);assert.equal(foreign.focuses,0);if(missing==='issue')assert.equal(f.controls.get(target).focuses,0);assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);
});

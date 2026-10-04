import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {deflateSync,inflateSync} from 'node:zlib';
import {newDraft} from '../../dist/local/src/request/core.js';
import {displayPreviewURL,displayProtocolURL} from '../display-module.mjs';
const {displayPreviewOwnership}=await import(displayPreviewURL),{displayPath,DISPLAY_HEADERS,DISPLAY_PROFILE}=await import(displayProtocolURL);
import {RequestEditing,allocationsURL,createOwnedModel,modelPayloadBytes,readOwnedJSON} from './request-controller-module.mjs';
import {rendered} from './queue-controls.mjs';
const ownedControllers=new Set(),fixtureCleanups=new Set();test.afterEach(async()=>{try{await Promise.all([...ownedControllers].map(controller=>controller.dispose()));}finally{ownedControllers.clear();for(const cleanup of fixtureCleanups)cleanup();fixtureCleanups.clear();}});const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};const tick=()=>new Promise(r=>setTimeout(r,5));
function find(t,part){if(!t||typeof t!=='object')return; if(t.strings){const id=/^<en-button id="([^"]+)"$/.exec(part)?.[1],i=t.strings.findIndex((s,index)=>s.includes(part)||id!==undefined&&s.endsWith('<en-button id=')&&t.values[index]===id);if(i>=0)return {strings:t.strings.slice(i),values:t.values.slice(i)};}for(const v of Array.isArray(t)?t:t.values??[]){const f=find(v,part);if(f)return f;}}
function publicButton(template,label){const matches=rendered({render:()=>template}).buttons.filter(button=>button.name===label);assert.equal(matches.length,1,'Exactly one actual public button '+label);assert.equal(typeof matches[0].click,'function','The rendered button retains its click binding');return matches[0];}
function event(value='',host={value,isConnected:true}){host.value=value;return {currentTarget:host,composedPath:()=>[host],defaultPrevented:false};}
function fixture(contextualOperationChanged,checkpointDrafts=[]){
 let instance,rendered,identity='client',native={value:'',isConnected:false,updateComplete:Promise.resolve()};const saved=[],reviews=[],responses=new Set(),draftRegistrations=new Map();
 const own=(value,owner='request-controller-fixture',kind='control')=>{const model=createOwnedModel(owner,modelPayloadBytes(value),()=>structuredClone(value),kind);responses.add(model);return model;};
 const ui=own({drafts:checkpointDrafts},'request-controller-ui');
 // Existing tests replace the raw methods below as transport callbacks. The
 // controller sees only independently admitted owned responses and scoped events.
 const editor={documentEpoch:1,view:{ready:true,document:{id:'doc',revision:'1'}},sessionId:'session',session:{identity:()=>identity},draftOwner:{drafts:new Map(),refused:new Map(),refuseChange(id,documentId){const row=draftRegistrations.get(this)?.get(id);assert(row&&row.count>0&&row.documentId===documentId,'Refusal requires the current registered draft identity');this.refused.set(id,documentId);},get hasRefusedChanges(){return this.refused.size>0;}},ui:ui.value,
  json:async()=>({items:[]}),command:async()=>[],upload:async()=>{throw Error('Unexpected upload');},
  registerDraft(id,documentId){
   const owner=this.draftOwner;if(!owner||this.view.document?.id!==documentId)throw Error('DRAFT_OWNER_CHANGED');
   if(typeof owner.registerDraft==='function')return owner.registerDraft(id,documentId);
   let rows=draftRegistrations.get(owner);if(!rows){rows=new Map();draftRegistrations.set(owner,rows);}let row=rows.get(id);
   if(row&&row.documentId!==documentId)throw Error('DRAFT_IDENTITY_CHANGED');if(row)row.count++;else{row={documentId,count:1};rows.set(id,row);}let live=true;
   return ()=>{if(!live)return;live=false;if(!--row.count){rows.delete(id);if(!rows.size)draftRegistrations.delete(owner);}};
  },
  pinUI(){return ui.pin();},
  pinViewModels(document,image){const model=createOwnedModel('request-controller-view-pin',modelPayloadBytes({document,image}),()=>({document,image}));responses.add(model);const unpin=model.pin();model.release();return unpin;},
  ownedJSON(path,owner,init,current=()=>true,maxBytes=1024**2,kind='control'){
   return readOwnedJSON(async()=>{const value=await this.json(path,init),wire=JSON.stringify(value);return new Response(wire,{headers:{'content-length':String(Buffer.byteLength(wire))}});},path,{owner,init,owns:current,maxBytes,kind}).then(model=>{responses.add(model);return model;});
  },
  async ownedRequestReview(body){return own(await this.requestReview(body),'request-controller-review');},
  async ownedUpload(...args){return own(await this.upload(...args),'request-controller-upload');},
  async ownedCommand(...args){const result=await this.command(...args);return own(Array.isArray(result)?result:[],'request-controller-events');},
  async withCommandEvents(body,work,...args){const model=await this.ownedCommand(body,...args);try{return await work(model.value);}finally{model.release();}},
  changeDraft(id,kind,text,target,composing,revision){saved.push({id,kind,text,target,composing,revision});const generation=String(saved.length);editor.draftOwner.drafts.set(id,{generation,savedGeneration:null});editor.draftOwner.refused?.delete(id);},
  async flushDrafts(){for(const d of editor.draftOwner.drafts.values())d.savedGeneration=d.generation;},
  async requestReview(body){reviews.push(body);return {review:{id:'review',token:'token',request:{kind:'generate'},prompt:{},estimate:{unknown:[]}},acceptedReview:'review'};}
 };
 // Model the one rendered native prompt, including accepted property writes
 // and removal at the actual parent render boundary used by disposal.
 const host={requestUpdate(){this.updateComplete=Promise.resolve().then(()=>{rendered=instance.render();const field=find(rendered,'<en-textarea id="prompt"');if(field){if(!native.isConnected)native={value:'',isConnected:true,updateComplete:Promise.resolve()};const value=field.values[field.strings.findIndex(part=>part.includes('.value='))];if(typeof value==='string')native.value=value;}else native.isConnected=false;});},updateComplete:Promise.resolve(),querySelector(selector){return selector==='#prompt'?(native.isConnected?native:null):{focus(){}};}};
 instance=new RequestEditing(host,editor,undefined,undefined,undefined,contextualOperationChanged);ownedControllers.add(instance);fixtureCleanups.add(()=>{assert.equal(draftRegistrations.size,0,'Every synthetic draft registration released');ui.release();for(const model of responses){assert.throws(()=>{const release=model.pin();release();},/MODEL_MEMORY_RELEASED/,'Every fixture result and UI root is released');}});
 return {instance,editor,host,saved,reviews,promptEvent(value=''){assert(native.isConnected,'Prompt control is mounted');return event(value,native);},async initial(){await instance.sync();host.requestUpdate();await flush();},template:()=>rendered,prompt:()=>find(rendered,'<en-textarea id="prompt"').values.find(x=>typeof x==='function'),button:()=>find(rendered,'<en-button id="prepare-request"').values.find(x=>typeof x==='function'),identity(v){identity=v;}};
}
for(const boundary of ['document','session','identity','connection','owner','disposed','operation'])for(const queued of [false,true])test('actual rendered request callback refuses '+boundary+' '+queued,async()=>{const f=fixture();await f.initial();const cb=f.prompt(),e=f.promptEvent('foreign');if(queued)cb(e);if(boundary==='document')f.editor.view.document={id:'new',revision:'1'};if(boundary==='session')f.editor.sessionId='new';if(boundary==='identity')f.identity('new');if(boundary==='connection')f.editor.session={...f.editor.session};if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};if(boundary==='disposed')f.instance.dispose();if(boundary==='operation')f.instance.operationChanged('Generate with Fast');const count=f.saved.length;if(!queued)cb(e);await flush();assert.equal(f.saved.length,count);assert(!f.saved.some(x=>JSON.parse(x.text).text==='foreign'));});
test('settled final cancellation and public value govern request field',async()=>{const f=fixture();await f.initial();let e=f.promptEvent('veto');f.prompt()(e);e.defaultPrevented=true;await flush();assert.equal(f.saved.length,0);assert.equal(f.editor.draftOwner.hasRefusedChanges,true);assert.equal(f.instance.inspectMemory().promptInput.refused,true);e=f.promptEvent('tentative');f.prompt()(e);e.currentTarget.value='settled';await flush();assert.equal(JSON.parse(f.saved[0].text).text,'settled');assert.equal(f.editor.draftOwner.hasRefusedChanges,false);assert.equal(f.instance.inspectMemory().promptInput.refused,false);});
test('pending action honors final native veto and detached hosts',async()=>{const f=fixture();await f.initial();for(const kind of ['veto','detach']){const e=event();f.button()(e);if(kind==='veto')e.defaultPrevented=true;else e.currentTarget.isConnected=false;await tick();}assert.equal(f.reviews.length,0);});
test('prepare binds saved current draft and accepted field value',async()=>{const f=fixture();await f.initial();f.prompt()(f.promptEvent('exact'));await flush();f.button()(event());await tick();await flush();assert.equal(f.reviews.length,1);assert.equal(f.reviews[0].type,'PrepareRequestReview');assert.equal(f.reviews[0].generation,f.editor.draftOwner.drafts.get(f.reviews[0].draftId).savedGeneration);});
for(const boundary of ['edit','owner','disposed'])test('pending prepare cannot publish review after '+boundary,async()=>{const f=fixture();await f.initial();f.prompt()(f.promptEvent('exact'));await flush();let release;f.editor.flushDrafts=()=>new Promise(r=>release=r);f.button()(event());await tick();if(boundary==='edit'){f.prompt()(f.promptEvent('new'));await flush();}else if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};else f.instance.dispose();release();await flush();assert.equal(f.reviews.length,0);});
test('operation switch preserves each complete incompatible draft',async()=>{const f=fixture();await f.initial();f.prompt()(f.promptEvent('base'));await flush();f.instance.operationChanged('Generate with Instant');await flush();f.prompt()(f.promptEvent('instant'));await flush();f.instance.operationChanged('Generate image');await flush();assert.equal(find(f.template(),'<en-textarea id="prompt"').values[1],'base');f.instance.operationChanged('Generate with Instant');await flush();assert.equal(find(f.template(),'<en-textarea id="prompt"').values[1],'instant');});
test('plain and raw prompt modes retain separate exact drafts',async()=>{const f=fixture();await f.initial();f.prompt()(f.promptEvent('plain retained'));await flush();const mode=()=>find(f.template(),'<en-select id=').values.find(x=>typeof x==='function');mode()(event('raw'));await flush();f.prompt()(f.promptEvent(' {"future":true} \n'));await flush();mode()(event('plain'));await flush();assert.equal(find(f.template(),'<en-textarea id="prompt"').values[1],'plain retained');mode()(event('raw'));await flush();assert.equal(find(f.template(),'<en-textarea id="prompt"').values[1],' {"future":true} \n');});
test('prepare drains an earlier in-flight save before requiring the current generation receipt',async()=>{const f=fixture();await f.initial();f.prompt()(f.promptEvent('current'));await flush();let calls=0;f.editor.flushDrafts=async()=>{if(++calls===1)return;for(const d of f.editor.draftOwner.drafts.values())d.savedGeneration=d.generation;};f.button()(event());await tick();await flush();assert.equal(calls,2);assert.equal(f.reviews.length,1);});
test('native composition start and end in one dispatch turn release review and save the settled draft',async()=>{const f=fixture();await f.initial();const callbacks=find(f.template(),'<section aria-label="Typed request draft"').values.filter(x=>typeof x==='function');callbacks[0]();callbacks[1]();await flush();assert.equal(f.saved.at(-1).composing,false);f.prompt()(f.promptEvent('settled IME'));await flush();f.button()(event());await tick();await flush();assert.equal(f.reviews.length,1);});
test('same-turn public fields retain both settled values for the same owner',async()=>{const f=fixture();await f.initial();const prompt=f.prompt(),seed=find(f.template(),'<en-text-field id="request-seed"').values.find(x=>typeof x==='function');prompt(f.promptEvent('Both values'));seed(event('9007199254740993123'));await flush();const last=JSON.parse(f.saved.at(-1).text);assert.equal(last.text,'Both values');assert.equal(last.draft.fields.seed,'9007199254740993123');});

for(const boundary of ['document','session','identity','connection','owner','disposed','operation'])for(const queued of [false,true])test('rendered operation selector refuses '+boundary+' '+queued,async()=>{const f=fixture();await f.initial();let changes=0;const cb=f.instance.operationChoice(()=>changes++),e=event('Generate with Instant');if(queued)cb(e);if(boundary==='document')f.editor.view.document={id:'new',revision:'1'};if(boundary==='session')f.editor.sessionId='new';if(boundary==='identity')f.identity('new');if(boundary==='connection')f.editor.session={...f.editor.session};if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};if(boundary==='disposed')f.instance.dispose();if(boundary==='operation')f.instance.operationChanged('Generate with Fast');const op=f.instance.operation,count=f.saved.length;if(!queued)cb(e);await flush();assert.equal(changes,0);assert.equal(f.instance.operation,op);assert.equal(f.saved.length,count);});

const fakeRef=(n,byteLength='24',mediaType='application/x-ideogram-rgba8')=>({hash:'sha256:'+String(n).repeat(64),byteLength,mediaType});
const maskManifest=()=>({plan:{hard:fakeRef(5,'12','application/x-ideogram-r16le'),effective:fakeRef(6,'12','application/x-ideogram-r16le'),statistics:{effectivePixels:2}}});
function selectTemplate(t,label){if(!t||typeof t!=='object')return;if(t.strings?.some(s=>s.includes('<en-select id='))&&t.values.includes(label))return t;for(const v of Array.isArray(t)?t:t.values??[]){const found=selectTemplate(v,label);if(found)return found;}}
async function selectField(f,label,value){const select=selectTemplate(f.template(),label);assert(select,'Rendered '+label+' selector');select.values.find(v=>typeof v==='function')(event(value));await flush();}
function assetProjection(assetId){
 const mask=assetId==='mask',pixels=fakeRef(assetId==='composite'?3:2),manifest=fakeRef(4,'24','application/json');
 const value={id:assetId,version:'2',purpose:'image',blob:fakeRef(1,'24','image/png'),dependencies:[pixels,manifest],safety:'safe',availability:'available',qualification:'canonical-raster',measuredMediaType:'image/png',raster:{schemaVersion:mask?2:1,pipeline:'cp1-f64-triangle-area-v1/'+fakeRef(7).hash,width:3,height:2,manifest,pixels,pixelIdentity:pixels.hash,role:mask?'mask':'native',sourceAssetIds:[],conversion:mask?null:{encodedWidth:3,encodedHeight:2,orientation:1,profile:'untagged-srgb',profileHash:null,colorChanged:false,orientationChanged:false,resized:false}}};
 return {protocolVersion:1,entityVersion:value.version,projectionSchema:2,highWater:'2',projection:{kind:'inline',value}};
}
async function maskController(translated=false){const f=fixture();Object.assign(f.editor.view.document,{width:3,height:2,image:{compositeAssetId:'composite'}});f.editor.view.selected=['picture'];f.editor.view.image={layers:[{id:'picture',version:'4',assetId:'source',layerToDocument:[1,0,0,1,translated?1:0,0],mask:{assetId:'mask',mapping:'document-r16-v1',inverted:false}}]};f.editor.json=async path=>path.endsWith('/request-reviews')?{items:[]}:path.endsWith('/raster')?maskManifest():assetProjection(path.split('/').at(-1));await f.initial();f.instance.operationChanged('Edit masked region');await flush();await selectField(f,'Request size','auto');return f;}
const actionById=(f,id)=>find(f.template(),'<en-button id="'+id+'"').values.find(v=>typeof v==='function');
async function act(f,id){actionById(f,id)(event());await tick();await flush();}
const lastDraft=f=>JSON.parse(f.saved.at(-1).text).draft;
test('public mask attachment captures exact frame and requires explicit compatible alignment',async()=>{const f=await maskController(true);await act(f,'request-source');await act(f,'request-mask');const original=lastDraft(f);assert.deepEqual(original.mask.frame.layer.transform,[1,0,0,1,1,0]);assert.equal(original.mask.frame.alignment,null);await act(f,'request-mask-alignment');assert.deepEqual(lastDraft(f),original);await act(f,'request-visible-source');const beforeAttach=lastDraft(f);await act(f,'request-mask-alignment');assert.deepEqual(lastDraft(f),beforeAttach);await act(f,'request-mask');await act(f,'request-mask-alignment');const next=lastDraft(f);assert.equal(next.source.scope,'visible-document');assert.deepEqual(next.mask.frame.alignment.sourceToDocument,[1,0,0,1,0,0]);assert.deepEqual(next.mask.frame.alignment.maskToDocument,[1,0,0,1,0,0]);assert.deepEqual(next.mask.pixels,original.mask.pixels);assert.deepEqual(next.mask.requestPlan.sourcePixels,next.source.pixels);assert.deepEqual(next.mask.requestPlan.authoredMask,maskManifest().plan.hard);assert.deepEqual(next.mask.requestPlan.effectiveMask,maskManifest().plan.effective);assert.deepEqual(next.mask.requestPlan.expectedOutput,{width:3,height:2});assert.equal(next.mask.requestPlan.reconstructionHalo,0);});
for(const boundary of ['owner','revision','veto'])test('alignment confirmation cannot survive '+boundary+' boundary',async()=>{const f=await maskController();await act(f,'request-source');await act(f,'request-mask');const cb=actionById(f,'request-mask-alignment'),e=event(),before=f.saved.length;cb(e);if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};if(boundary==='revision')f.editor.view.document={...f.editor.view.document,revision:'2'};if(boundary==='veto')e.defaultPrevented=true;await tick();await flush();assert.equal(f.saved.length,before);assert.equal(lastDraft(f).mask.frame.alignment,null);});
test('pending mask read cannot attach to a replacement owner',async()=>{const f=await maskController();await act(f,'request-source');let release;const read=f.editor.json;f.editor.json=path=>path.endsWith('/raster')?new Promise(r=>release=r):read(path);actionById(f,'request-mask')(event());await tick();await flush();assert(release);f.editor.draftOwner={drafts:new Map()};release({plan:{statistics:{effectivePixels:2}}});await flush();assert.equal(lastDraft(f).mask,null);});

for(const boundary of ['owner','session','identity','document','disposed','veto'])for(const queued of [false,true])test('public queue refresh refuses stale authority '+boundary+' '+queued,async()=>{const f=fixture();await f.initial();let calls=0;f.editor.json=async()=>{calls++;return {session:{id:'session',cap:null},jobs:[],counts:{},limits:{}};};const cb=actionById(f,'refresh-queue'),e=event();if(queued)cb(e);if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};if(boundary==='session')f.editor.sessionId='new';if(boundary==='identity')f.identity('new');if(boundary==='document')f.editor.view.document={id:'new',revision:'1'};if(boundary==='disposed')f.instance.dispose();if(boundary==='veto')e.defaultPrevented=true;if(!queued)cb(e);await tick();await flush();assert.equal(calls,0);});

async function riskController(kind){const f=fixture();await f.initial();const displayed={jobId:'displayed-job',attemptId:'displayed-attempt',expectedVersion:'7',kind};f.instance.riskReview=displayed;f.host.requestUpdate();await flush();return {...f,displayed,confirm:()=>publicButton(find(f.template(),'<en-card id="queue-risk"'),'Acknowledge risk and '+(kind==='override'?'release this local hold':'create a new attempt')).click};}
for(const kind of ['override','retry']){
 for(const scheduled of [false,true])test('rendered '+kind+' refuses replaced selection '+(scheduled?'after scheduling':'before invocation'),async()=>{const f=await riskController(kind),commands=[];f.editor.command=async body=>commands.push(body);const callback=f.confirm(),replacement={jobId:'replacement-job',attemptId:'replacement-attempt',expectedVersion:'9',kind};if(scheduled)callback(event());f.instance.riskReview=replacement;if(!scheduled)callback(event());await tick();await flush();assert.deepEqual(commands,[]);assert.equal(f.instance.riskReview,replacement);});
 test('rendered '+kind+' sends exact displayed payload and retains selection replaced during completion',async()=>{const f=await riskController(kind),commands=[];let complete;f.editor.command=(body,document)=>{commands.push({body,document});return new Promise(r=>complete=r);};f.editor.json=async()=>null;f.confirm()(event());await tick();await flush();assert.equal(commands.length,1);assert.deepEqual(commands[0],{document:null,body:kind==='override'?{type:'OverrideUncertainHold',jobId:'displayed-job',attemptId:'displayed-attempt',expectedVersion:'7',acknowledgeOverlapAndChargeRisk:true}:{type:'RetryUncertainJob',jobId:'displayed-job',attemptId:'displayed-attempt',expectedVersion:'7',acknowledgeDuplicateWorkAndChargeRisk:true}});const replacement={jobId:'replacement-job',attemptId:'replacement-attempt',expectedVersion:'9',kind};f.instance.riskReview=replacement;complete();await tick();await flush();assert.equal(f.instance.riskReview,replacement);assert.equal(commands.length,1);});
 test('rendered '+kind+' honors late native veto',async()=>{const f=await riskController(kind),commands=[];f.editor.command=async body=>commands.push(body);const e=event();f.confirm()(e);e.defaultPrevented=true;await tick();await flush();assert.deepEqual(commands,[]);assert.equal(f.instance.riskReview,f.displayed);});
}

async function capController(){const f=fixture();await f.initial();const queue={session:{id:'spend-session',version:'4',cap:null},jobs:[],counts:{},limits:{},nextCursor:null},commands=[];f.editor.command=async(body,document)=>{commands.push({body,document});};f.editor.json=async()=>queue;f.instance.queue=queue;f.host.requestUpdate();await flush();return {...f,commands,queue,field:()=>find(f.template(),'<en-number-field id="request-cap"').values.filter(v=>typeof v==='function'),set:()=>actionById(f,'set-request-cap')};}
test('disposing during a public queue refresh prevents later polling and publication',async()=>{const f=await capController();let calls=0,release;f.editor.json=async()=>{calls++;return calls===1?f.queue:new Promise(r=>release=r);};actionById(f,'refresh-queue')(event());for(let n=0;!release&&n<100;n++)await tick();assert.equal(calls,2);f.instance.dispose();release(f.queue);await new Promise(r=>setTimeout(r,200));await flush();assert.equal(calls,2);assert.equal(f.instance.queue,null);});
function capEvent(host,draft=host.value,composing=false){return {currentTarget:host,composedPath:()=>[host],defaultPrevented:false,detail:{value:draft,isComposing:composing}};}
async function commitCap(f,host,value){host.value=value;f.field()[1](capEvent(host));await flush();}
async function submitCap(f){f.set()(event());await tick();await flush();}
test('cap draft notification cannot submit an older accepted value; typed acceptance sends exact payload',async()=>{const f=await capController(),host={value:'',isConnected:true};await commitCap(f,host,'7');f.field()[0](capEvent(host,'8'));await flush();await submitCap(f);assert.deepEqual(f.commands,[]);await commitCap(f,host,'8');await submitCap(f);assert.deepEqual(f.commands,[{document:null,body:{type:'SetSpendGuard',spendSessionId:'spend-session',expectedConfigVersion:'4',cap:8}}]);});
test('cap public stepper acceptance works without draft-input notification',async()=>{const f=await capController(),host={value:'',isConnected:true};await commitCap(f,host,'2');await submitCap(f);assert.equal(f.commands[0].body.cap,2);await commitCap(f,host,'1');await submitCap(f);assert.equal(f.commands[1].body.cap,1);});
test('cap late-veto rollback blocks submission until a later accepted change',async()=>{const f=await capController(),host={value:'',isConnected:true};await commitCap(f,host,'2');host.value='3';const veto=capEvent(host);f.field()[1](veto);veto.defaultPrevented=true;host.value='2';await flush();await submitCap(f);assert.deepEqual(f.commands,[]);assert.equal(f.instance.cap,'2');await commitCap(f,host,'4');await submitCap(f);assert.equal(f.commands[0].body.cap,4);});
test('cap uses final accepted host value and latest rapid acceptance, never tentative details',async()=>{const f=await capController(),host={value:'2',isConnected:true},change=f.field()[1];change(capEvent(host,'999'));host.value='3';change(capEvent(host,'888'));host.value='4';await flush();await submitCap(f);assert.equal(f.commands.length,1);assert.equal(f.commands[0].body.cap,4);});
for(const value of ['', '0','-1','1.5','9007199254740992'])test('cap refuses invalid accepted value '+JSON.stringify(value),async()=>{const f=await capController(),host={value:'',isConnected:true};await commitCap(f,host,value);await submitCap(f);assert.deepEqual(f.commands,[]);assert.equal(f.instance.issues[0].code,'REQUEST_CAP');});
test('cap composition draft cannot submit the earlier accepted value',async()=>{const f=await capController(),host={value:'',isConnected:true};await commitCap(f,host,'2');f.field()[0](capEvent(host,'3',true));await flush();await submitCap(f);assert.deepEqual(f.commands,[]);});
for(const boundary of ['owner','session','document','identity','disposed'])for(const queued of [false,true])test('cap accepted callback refuses '+boundary+' '+queued,async()=>{const f=await capController(),host={value:'5',isConnected:true},callback=f.field()[1],e=capEvent(host);if(queued)callback(e);if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};if(boundary==='session')f.editor.sessionId='other';if(boundary==='document')f.editor.view.document={id:'other',revision:'1'};if(boundary==='identity')f.identity('other');if(boundary==='disposed')f.instance.dispose();if(!queued)callback(e);await flush();assert.equal(f.instance.cap,'');assert.deepEqual(f.commands,[]);});

test('cap same-turn composition tail preserves accepted transaction',async()=>{const f=await capController(),host={value:'',isConnected:true},[input,change]=f.field();input(capEvent(host,'1'));host.value='1';change(capEvent(host));input(capEvent(host,'1'));await flush();await submitCap(f);assert.deepEqual({accepted:f.instance.cap,pending:f.instance.capPending,commands:f.commands},{accepted:'1',pending:false,commands:[{document:null,body:{type:'SetSpendGuard',spendSessionId:'spend-session',expectedConfigVersion:'4',cap:1}}]});});
test('cap different composition tail stays pending until that new draft is accepted',async()=>{const f=await capController(),host={value:'',isConnected:true},[input,change]=f.field();input(capEvent(host,'1'));host.value='1';change(capEvent(host));input(capEvent(host,'12'));await flush();await submitCap(f);assert.equal(f.instance.cap,'1');assert.equal(f.instance.capPending,true);assert.deepEqual(f.commands,[]);host.value='12';change(capEvent(host));input(capEvent(host,'12'));await flush();await submitCap(f);assert.deepEqual(f.commands,[{document:null,body:{type:'SetSpendGuard',spendSessionId:'spend-session',expectedConfigVersion:'4',cap:12}}]);});
test('cap veto with rollback and duplicate tail cannot submit the previous accepted value',async()=>{const f=await capController(),host={value:'',isConnected:true};await commitCap(f,host,'2');const [input,change]=f.field();input(capEvent(host,'3'));host.value='3';const proposal=capEvent(host);change(proposal);proposal.defaultPrevented=true;host.value='2';input(capEvent(host,'2'));await flush();await submitCap(f);assert.equal(f.instance.cap,'2');assert.equal(f.instance.capPending,true);assert.deepEqual(f.commands,[]);await commitCap(f,host,'4');await submitCap(f);assert.equal(f.commands[0].body.cap,4);});
test('cap veto keeps delayed rollback tails blocked until a new proposal is accepted',async()=>{
 const f=await capController(),host={value:'',isConnected:true};await commitCap(f,host,'2');
 const [input,change]=f.field();input(capEvent(host,'3'));host.value='3';const proposal=capEvent(host);change(proposal);proposal.defaultPrevented=true;host.value='2';
 await flush();assert.equal(f.instance.cap,'2');assert.equal(f.instance.capPending,true);
 for(let tail=0;tail<2;tail++){
  input(capEvent(host,'2'));await flush();assert.equal(f.instance.capPending,true,'A rollback tail cannot accept a vetoed proposal');
  await submitCap(f);assert.deepEqual(f.commands,[],'The previous accepted cap must not be submitted');
 }
 await commitCap(f,host,'4');await submitCap(f);assert.deepEqual(f.commands,[{document:null,body:{type:'SetSpendGuard',spendSessionId:'spend-session',expectedConfigVersion:'4',cap:4}}]);
});
test('cap rapid accepted transactions with duplicate tails submit only the newest value',async()=>{const f=await capController(),host={value:'',isConnected:true},[input,change]=f.field();for(const value of ['1','12','123']){input(capEvent(host,value));host.value=value;change(capEvent(host));input(capEvent(host,value));}await flush();await submitCap(f);assert.deepEqual(f.commands,[{document:null,body:{type:'SetSpendGuard',spendSessionId:'spend-session',expectedConfigVersion:'4',cap:123}}]);});
test('cap accepted transaction followed by composing draft remains blocked',async()=>{const f=await capController(),host={value:'1',isConnected:true},[input,change]=f.field();change(capEvent(host));input(capEvent(host,'1',true));await flush();await submitCap(f);assert.deepEqual(f.commands,[]);input(capEvent(host,'1',false));await flush();await submitCap(f);assert.equal(f.commands[0].body.cap,1);});
test('cap outer composition guards commands until the native end callback',async()=>{const f=await capController(),host={value:'',isConnected:true};const [start,end]=find(f.template(),'<section aria-label="Typed request draft"').values.filter(v=>typeof v==='function');start();await flush();const [input,change]=f.field();input(capEvent(host,'1',true));host.value='1';change(capEvent(host));input(capEvent(host,'1',false));await flush();await submitCap(f);assert.deepEqual(f.commands,[]);assert.equal(f.instance.composing,true);end();await flush();await submitCap(f);assert.deepEqual(f.commands,[{document:null,body:{type:'SetSpendGuard',spendSessionId:'spend-session',expectedConfigVersion:'4',cap:1}}]);assert.equal(f.saved.at(-1).composing,false);});
test('cap outer composition end and duplicate tail in one turn preserve exact acceptance',async()=>{const f=await capController(),host={value:'',isConnected:true},[input,change]=f.field(),[start,end]=find(f.template(),'<section aria-label="Typed request draft"').values.filter(v=>typeof v==='function');start();input(capEvent(host,'1'));host.value='1';change(capEvent(host));end();input(capEvent(host,'1'));await flush();await submitCap(f);assert.equal(f.instance.composing,false);assert.equal(f.instance.capPending,false);assert.equal(f.commands.length,1);assert.equal(f.commands[0].body.cap,1);});
for(const boundary of ['owner','session','document','identity','disposed','connection','operation'])test('cap composition tail cannot cross '+boundary+' replacement before settlement',async()=>{const f=await capController(),host={value:'',isConnected:true},[input,change]=f.field(),set=f.set();input(capEvent(host,'1'));host.value='1';change(capEvent(host));input(capEvent(host,'1'));if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};if(boundary==='session')f.editor.sessionId='other';if(boundary==='document')f.editor.view.document={id:'other',revision:'1'};if(boundary==='identity')f.identity('other');if(boundary==='disposed')f.instance.dispose();if(boundary==='connection')f.editor.session={...f.editor.session};if(boundary==='operation')f.instance.operationChanged('Generate with Fast');await flush();set(event());await tick();await flush();assert.equal(f.instance.cap,'');assert.deepEqual(f.commands,[]);});


for(const boundary of ['owner','revision','session','identity','connection','operation','disposed','edit'])test('asynchronous request mask confirmation discards retained coverage after '+boundary+' changes',async()=>{const f=await maskController();await act(f,'request-source');await act(f,'request-mask');let release;const read=f.editor.json;f.editor.json=path=>path.endsWith('/raster')?new Promise(r=>release=r):read(path);actionById(f,'request-mask-alignment')(event());await tick();await flush();assert(release,'Confirmation reads retained coverage before granting approval');const before=lastDraft(f);assert.equal(before.mask.frame.alignment,null);assert.equal(before.mask.requestPlan,undefined);if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};if(boundary==='revision')f.editor.view.document={...f.editor.view.document,revision:'2'};if(boundary==='session')f.editor.sessionId='replacement';if(boundary==='identity')f.identity('replacement');if(boundary==='connection')f.editor.session={...f.editor.session};if(boundary==='operation')f.instance.operationChanged('Generate image');if(boundary==='disposed')f.instance.dispose();if(boundary==='edit'){f.prompt()(f.promptEvent('New request intent'));await flush();}const writes=f.saved.length,expectedDraft=structuredClone(lastDraft(f));release(maskManifest());await flush();await tick();assert.equal(f.saved.length,writes,'Stale asynchronous approval cannot save into a newer draft');assert.deepEqual(lastDraft(f),expectedDraft,'Stale coverage cannot mutate the replacement draft');if(boundary==='operation')assert.equal(lastDraft(f).mask,null,'Generation clears the previous operation mask');else{assert.equal(lastDraft(f).mask.frame.alignment,null);assert.equal(lastDraft(f).mask.requestPlan,undefined);}});
for(const size of ['square_hd','custom'])test('public alignment confirmation refuses '+size+' mapping before reading coverage',async()=>{const f=await maskController();await act(f,'request-source');await act(f,'request-mask');await selectField(f,'Request size',size);let reads=0;const read=f.editor.json;f.editor.json=path=>{if(path.endsWith('/raster'))reads++;return read(path);};const before=lastDraft(f);await act(f,'request-mask-alignment');assert.equal(reads,0);assert.deepEqual(lastDraft(f),before);assert.equal(lastDraft(f).mask.requestPlan,undefined);assert.equal(f.instance.issues[0].code,'MASK_MAPPING_REVIEW_REQUIRED');});
test('retained coverage read failure leaves alignment and request mask plan unapproved',async()=>{const f=await maskController();await act(f,'request-source');await act(f,'request-mask');const before=lastDraft(f),read=f.editor.json;f.editor.json=path=>path.endsWith('/raster')?Promise.reject(Error('Retained coverage unavailable')):read(path);await act(f,'request-mask-alignment');assert.deepEqual(lastDraft(f),before);assert.equal(lastDraft(f).mask.frame.alignment,null);assert.equal(lastDraft(f).mask.requestPlan,undefined);assert.match(f.instance.issues[0].message,/Retained coverage unavailable/);});
test('mapping changes revoke confirmation while preserving original coverage and require fresh approval after returning to the original size',async()=>{const f=await maskController();await act(f,'request-source');await act(f,'request-mask');await act(f,'request-mask-alignment');const before=lastDraft(f),approved=before.mask.requestPlan;assert(approved);assert(find(f.template(),'Request mask plan confirmed'));await selectField(f,'Request size','square_hd');assert(find(f.template(),'Request mask plan needs confirmation.'));assert.equal(find(f.template(),'Request mask plan confirmed'),undefined);assert.equal(lastDraft(f).mask.requestPlan,undefined);assert.deepEqual(lastDraft(f).source,before.source);for(const field of ['blob','pixels','plan','frame'])assert.deepEqual(lastDraft(f).mask[field],before.mask[field]);await selectField(f,'Request size','auto');assert.equal(lastDraft(f).mask.requestPlan,undefined);assert(find(f.template(),'Request mask plan needs confirmation.'));assert.equal(find(f.template(),'Request mask plan confirmed'),undefined);await act(f,'request-mask-alignment');const renewed=lastDraft(f).mask.requestPlan;assert(renewed);assert.notEqual(renewed.approvalId,approved.approvalId);assert.deepEqual(renewed.authoredMask,approved.authoredMask);assert.deepEqual(renewed.effectiveMask,approved.effectiveMask);assert.deepEqual(renewed.sourcePixels,approved.sourcePixels);assert(find(f.template(),'Request mask plan confirmed'));});

function requestNumber(t,field){if(!t||typeof t!=='object')return;if(t.strings?.some(s=>s.includes('<en-number-field id='))&&t.values.includes('request-'+field))return t;for(const v of Array.isArray(t)?t:t.values??[]){const found=requestNumber(v,field);if(found)return found;}}
function numberChange(f,field){const number=requestNumber(f.template(),field);assert(number,'Rendered request '+field);const callbacks=number.values.filter(value=>typeof value==='function');assert.equal(callbacks.length,2,'Number field exposes input and change handlers');return callbacks[1];}
for(const field of ['width','height'])test('request '+field+' change-only stepper uses its settled visible value and revokes mapping approval unless vetoed',async()=>{
 const f=await maskController();await act(f,'request-source');await act(f,'request-mask');await selectField(f,'Request size','custom');for(const [name,value]of [['width','3'],['height','2']]){numberChange(f,name)(event(value));await flush();}await act(f,'request-mask-alignment');const before=lastDraft(f),writes=f.saved.length;assert(before.mask.requestPlan);
 const veto=event('4');numberChange(f,field)(veto);veto.defaultPrevented=true;veto.currentTarget.value=before.fields[field];await flush();assert.equal(f.saved.length,writes);assert.deepEqual(lastDraft(f),before);assert(find(f.template(),'Request mask plan confirmed'));
 const accepted=event('4');accepted.detail={value:'999'};numberChange(f,field)(accepted);accepted.currentTarget.value='5';await flush();const next=lastDraft(f);assert.equal(next.fields[field],'5');assert.equal(requestNumber(f.template(),field).values[2],'5');assert.equal(next.mask.requestPlan,undefined);assert(find(f.template(),'Request mask plan needs confirmation.'));assert.equal(find(f.template(),'Request mask plan confirmed'),undefined);assert.deepEqual(next.source,before.source);for(const key of ['blob','pixels','plan','frame'])assert.deepEqual(next.mask[key],before.mask[key]);
});

function requestAnnouncement(f){const region=find(f.template(),'id="request-announcements"');assert(region,'A dedicated request status region stays rendered');assert.match(region.strings[0],/role="status"/);assert.match(region.strings[0],/aria-live="polite"/);assert.match(region.strings[0],/aria-atomic="true"/);assert.equal(typeof region.values[0],'string','The live region has one stable text binding');return region.values[0];}
function assertReleasedRequestStatus(f){
 assert.equal(find(f.template(),'id="request-announcements"'),undefined,'Disposal removes the released live region');
 assert.equal(find(f.template(),'<en-button id="request-read-status"'),undefined,'Disposal removes the released status action');
 assert.equal(f.instance.announcement,'','No retired announcement text remains');
 const memory=f.instance.inspectMemory();assert.equal(memory.disposed,true);assert.equal(memory.releasing,false);
 for(const key of ['entries','retiredEntries','entryTasks','entryHolds','entryReads','entryCleanup','promptReads','announcementStates','transferAnnouncements','repairFiles'])assert.equal(memory[key],0,'Disposed request released '+key);
 assert.equal(memory.promptInput.retired,0);assert.equal(memory.promptInput.capacity,0);
 for(const owner of ['controls','candidates','prompts','files'])assert.deepEqual(memory.navigation[owner],{models:0,reads:0,pending:0,cleanupFailures:0},'Disposed navigation released '+owner);
 for(const key of ['candidatePages','candidateBytes','candidateReads','fileBytes'])assert.equal(memory.navigation[key],0,'Disposed navigation released '+key);
}
function observeRequestAnnouncements(f){const changes=[requestAnnouncement(f)],focus=[],update=f.host.requestUpdate.bind(f.host);f.host.requestUpdate=function(){update();this.updateComplete=this.updateComplete.then(()=>{const region=find(f.template(),'id="request-announcements"');if(region&&changes.at(-1)!==region.values[0])changes.push(region.values[0]);});};const query=f.host.querySelector.bind(f.host);f.host.querySelector=selector=>selector==='#prompt'?query(selector):({focus(){focus.push(selector);}});return {changes,focus};}
const frozenReview=()=>({kind:'request-review-1',id:'review',token:'token',documentId:'doc',documentRevision:'1',endpoint:'ideogram/v4',request:{kind:'generate',settings:{count:1},adapters:[]},prompt:fakeRef(1,'1','text/plain'),estimate:{rate:1,unit:'image',count:1,source:'fixture',unknown:[]}});
function queueObservation(terminal=null){return {protocolVersion:1,session:{id:'spend-session',version:'1',cap:null,createdAt:'1',previousSessionId:null},jobs:[{id:'job',version:'1',documentId:'doc',review:frozenReview(),local:'ready-to-dispatch',resultImport:'none',disposition:'eligible',attempts:[{id:'attempt',previousAttemptId:null,version:'1',state:terminal?'provider-terminal':'acknowledged',hold:!terminal,override:false,spendSessionId:'spend-session',count:'dispatched',writerEpoch:'1',payloadHash:null,requestId:'provider-request',terminal,uncertainReason:null,actualCharge:null,estimate:{rate:1,unit:'image',count:1,source:'fixture',unknown:[]}}]}],nextCursor:null,counts:{reserved:0,dispatched:1,remaining:null,active:terminal?0:1},limits:{active:1,target:100,maximum:1000},production:'denied'};}
function candidateObservation(state='prepared',phase='completed'){return {protocolVersion:1,jobId:'job',documentId:'doc',request:{endpoint:'ideogram/v4',prompt:fakeRef(1,'1','text/plain'),seed:null},observation:{phase,nextPollAt:0,failures:0,mode:'healthy',digest:null,resultDigest:null,warning:null},requestedCount:1,actualCount:1,items:[{id:'candidate',version:'1',documentId:'doc',jobId:'job',attemptId:'attempt',requestId:'provider-request',outputIndex:0,outputIdentity:'output',safety:'safe',state,hidden:false,encodedAssetId:'encoded',preparedAssetId:state==='prepared'?'prepared':null,warning:null}],provenance:null,inert:false,nextCursor:null};}
async function publishQueue(f,view){f.editor.json=async()=>structuredClone(view);await f.instance.refreshQueue();await flush();}
async function publishCandidates(f,view){f.editor.json=async()=>structuredClone(view);await f.instance.inspectCandidates('job','attempt');await flush();}

test('queue polls keep a stable polite status binding without moving focus',async()=>{const f=fixture();await f.initial();const observed=observeRequestAnnouncements(f),view=queueObservation();await publishQueue(f,view);const before=requestAnnouncement(f),count=observed.changes.length;for(let i=0;i<3;i++)await publishQueue(f,view);assert.equal(requestAnnouncement(f),before);assert.equal(observed.changes.length,count);assert.deepEqual(observed.focus,[]);});
for(const terminal of ['completed','failed','cancelled'])test('queue '+terminal+' is announced once despite repeated polling and metadata versions',async()=>{const f=fixture();await f.initial();const observed=observeRequestAnnouncements(f);await publishQueue(f,queueObservation());const before=observed.changes.length,view=queueObservation(terminal);await publishQueue(f,view);const announced=requestAnnouncement(f);assert.match(announced,new RegExp(terminal==='cancelled'?'cancel':terminal,'i'));assert.equal(observed.changes.length,before+1);for(let n=2;n<=4;n++){view.jobs[0].version=String(n);view.jobs[0].attempts[0].version=String(n);await publishQueue(f,view);assert.equal(requestAnnouncement(f),announced);}assert.equal(observed.changes.length,before+1);assert.deepEqual(observed.focus,[]);});
test('candidate readiness is announced once while repeated inspections preserve focus',async()=>{const f=fixture();await f.initial();const observed=observeRequestAnnouncements(f);await publishQueue(f,queueObservation('completed'));const pending=candidateObservation('received');await publishCandidates(f,pending);const before=observed.changes.length,ready=candidateObservation();await publishCandidates(f,ready);const announced=requestAnnouncement(f);assert.match(announced,/ready|prepared/i);assert.equal(observed.changes.length,before+1);for(let n=2;n<=4;n++){ready.items[0].version=String(n);ready.observation.nextPollAt=n*1000;await publishCandidates(f,ready);assert.equal(requestAnnouncement(f),announced);}assert.equal(observed.changes.length,before+1);assert.deepEqual(observed.focus,[]);});
test('queue and empty candidate observations share one terminal announcement',async()=>{const f=fixture();await f.initial();const observed=observeRequestAnnouncements(f);await publishQueue(f,queueObservation('completed'));const before=requestAnnouncement(f),count=observed.changes.length,view=candidateObservation();view.items=[];await publishCandidates(f,view);await publishCandidates(f,view);assert.equal(requestAnnouncement(f),before);assert.equal(observed.changes.length,count);assert.deepEqual(observed.focus,[]);});
for(const source of ['queue','candidates'])for(const boundary of ['owner','session','document','identity','connection','disposed'])test('deferred '+source+' observation cannot announce after '+boundary+' replacement',{timeout:5000},async()=>{const f=fixture();await f.initial();const observed=observeRequestAnnouncements(f),before=requestAnnouncement(f);let release,disposed;f.editor.json=()=>new Promise(resolve=>release=resolve);const pending=source==='queue'?f.instance.refreshQueue():f.instance.inspectCandidates('job','attempt');await flush();assert(release);if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};if(boundary==='session')f.editor.sessionId='new-session';if(boundary==='document')f.editor.view.document={id:'new-document',revision:'1'};if(boundary==='identity')f.identity('new-identity');if(boundary==='connection')f.editor.session={...f.editor.session};if(boundary==='disposed')disposed=f.instance.dispose();release(source==='queue'?queueObservation('completed'):candidateObservation());await assert.rejects(pending,{name:'AbortError'});await disposed;await flush();if(boundary==='disposed')assertReleasedRequestStatus(f);else assert.equal(requestAnnouncement(f),before);assert.deepEqual(observed.changes,[before]);assert.deepEqual(observed.focus,[]);if(source==='queue')assert.equal(f.instance.queue,null);else assert.equal(f.instance.candidateViews.size,0);});
for(const boundary of ['session','document'])test('a '+boundary+' change resets request announcements and their deduplication owner',async()=>{const f=fixture();await f.initial();const observed=observeRequestAnnouncements(f);await publishQueue(f,queueObservation('completed'));assert.match(requestAnnouncement(f),/completed/i);if(boundary==='session')f.editor.sessionId='new-session';else f.editor.view.document={id:'new-document',revision:'1'};f.editor.json=async()=>({items:[]});await f.instance.sync();f.host.requestUpdate();await flush();assert.equal(requestAnnouncement(f),'');const view=queueObservation('completed');view.jobs[0].documentId=f.editor.view.document.id;await publishQueue(f,view);assert.match(requestAnnouncement(f),/completed/i);assert.equal(observed.changes.filter(text=>/completed/i.test(text)).length,2,'A different owner can announce its own matching terminal identity');assert.deepEqual(observed.focus,[]);});
for(const outcome of ['saved','failed'])test('public queue action announces one pending and '+outcome+' outcome',async()=>{const f=await capController(),observed=observeRequestAnnouncements(f),control={value:'',isConnected:true};await commitCap(f,control,'3');let finish;f.editor.command=()=>new Promise((resolve,reject)=>finish=()=>outcome==='saved'?resolve():reject(Error('Writer connection interrupted')));f.set()(event());await tick();await flush();assert(finish,'The public action reached the durable command');assert.match(requestAnnouncement(f),/saving/i);assert.equal(observed.changes.filter(text=>/saving/i.test(text)).length,1);finish();await tick();await flush();assert.match(requestAnnouncement(f),outcome==='saved'?/saved/i:/could not be confirmed/i);assert.equal(observed.changes.length,3,'Initial text, one pending message and one outcome');if(outcome==='saved'){assert.deepEqual(observed.focus,[]);const before=requestAnnouncement(f);await publishQueue(f,f.queue);assert.equal(requestAnnouncement(f),before);assert.equal(observed.changes.length,3);}else assert.equal(f.instance.issues[0].message,'Writer connection interrupted');});
test('local review acceptance has pending and accepted announcements without queueing a job',async()=>{const f=fixture();await f.initial();f.prompt()(f.promptEvent('Reviewed prompt'));await flush();await act(f,'prepare-request');const observed=observeRequestAnnouncements(f);let complete;const calls=[];f.editor.requestReview=body=>{calls.push(body);return new Promise(resolve=>complete=()=>resolve({acceptedReview:'review',requestId:'acceptance'}));};actionById(f,'accept-request')(event());await tick();await flush();assert(complete);assert.match(requestAnnouncement(f),/saving.*acceptance/i);complete();await flush();assert.match(requestAnnouncement(f),/accepted locally/i);assert.match(requestAnnouncement(f),/no job was queued/i);assert.deepEqual(calls,[{type:'AcceptRequestReview',reviewId:'review',token:'token'}]);assert.equal(observed.changes.length,3);assert.deepEqual(observed.focus,[]);});

test('Read current status deliberately repeats the current summary without moving focus or reading the server',async()=>{
 const f=fixture();await f.initial();f.instance.queue=queueObservation('completed');f.instance.candidateViews.set('attempt',candidateObservation());f.host.requestUpdate();await flush();const observed=observeRequestAnnouncements(f);let reads=0;f.editor.json=async()=>{reads++;throw Error('Read current status must use the current retained view');};
 const control=find(f.template(),'<en-button id="request-read-status"');assert(control);assert.equal(publicButton(control,'Read current status').name,'Read current status');let summary;
 for(let i=0;i<3;i++){await act(f,'request-read-status');const current=requestAnnouncement(f);assert.match(current,/Current request status/);assert.match(current,/Request job, attempt attempt: completed/);assert.match(current,/1 retained outputs ready/);if(i)assert.equal(current,summary);summary=current;}
 assert.deepEqual(observed.changes,['',summary,'',summary,'',summary],'A rendered empty boundary makes each explicit repeat observable');assert.equal(reads,0);assert.deepEqual(observed.focus,[]);
});
for(const boundary of ['owner','session','document','identity','connection','disposed'])test('Read current status cannot republish a summary after '+boundary+' changes during the render boundary',{timeout:5000},async()=>{
 const f=fixture();await f.initial();const observed=observeRequestAnnouncements(f),update=f.host.requestUpdate.bind(f.host);let release,disposed;f.host.requestUpdate=function(){update();this.updateComplete=this.updateComplete.then(()=>new Promise(resolve=>release=resolve));};
 actionById(f,'request-read-status')(event());await tick();await flush();assert(release,'The explicit read awaits the cleared live-region render');assert.equal(requestAnnouncement(f),'');f.host.requestUpdate=update;
 if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};if(boundary==='session')f.editor.sessionId='new-session';if(boundary==='document')f.editor.view.document={id:'new-document',revision:'1'};if(boundary==='identity')f.identity('new-identity');if(boundary==='connection')f.editor.session={...f.editor.session};if(boundary==='disposed')disposed=f.instance.dispose();release();await disposed;await flush();if(boundary==='disposed')assertReleasedRequestStatus(f);else assert.equal(requestAnnouncement(f),'');assert.deepEqual(observed.changes,['']);assert.deepEqual(observed.focus,[]);
});
function announcementClock(t){let now=1000;t.mock.method(performance,'now',()=>now);t.mock.timers.enable({apis:['setTimeout']});return {async advance(milliseconds){now+=milliseconds;t.mock.timers.tick(milliseconds);await flush();}};}
test('transfer announcements wait five seconds and coalesce each output to its newest phase',async t=>{
 const f=fixture();await f.initial();const clock=announcementClock(t),observed=observeRequestAnnouncements(f);await publishCandidates(f,candidateObservation('received'));const initial=requestAnnouncement(f);assert.match(initial,/was received/);await clock.advance(1);
 const progress=candidateObservation('downloaded');await publishCandidates(f,progress);await publishCandidates(f,progress);assert.equal(requestAnnouncement(f),initial);await clock.advance(4998);assert.equal(requestAnnouncement(f),initial);assert.equal(observed.changes.length,2);await clock.advance(1);const downloaded=requestAnnouncement(f);assert.match(downloaded,/was downloaded/);assert.equal(observed.changes.length,3);
 await clock.advance(1);const next=candidateObservation('downloaded');next.items.push({...next.items[0],id:'candidate-2',outputIndex:1,state:'received'},{...next.items[0],id:'candidate-3',outputIndex:2,state:'received'});await publishCandidates(f,next);await clock.advance(1);next.items[1].state='downloaded';await publishCandidates(f,next);assert.equal(requestAnnouncement(f),downloaded);await clock.advance(4997);assert.equal(requestAnnouncement(f),downloaded);await clock.advance(1);
 const combined=requestAnnouncement(f);assert.match(combined,/Output 2 .*was downloaded/);assert.match(combined,/Output 3 .*was received/);assert.doesNotMatch(combined,/Output 2 [^.]*was received/);assert.equal(observed.changes.length,4,'Both pending outputs share one paced announcement');await clock.advance(10000);await publishCandidates(f,next);assert.equal(requestAnnouncement(f),combined);assert.equal(observed.changes.length,4);assert.deepEqual(observed.focus,[]);
});
for(const [state,message]of [['prepared',/prepared for explicit placement/],['transfer-failed',/could not be retrieved/],['preparation-failed',/could not be prepared/],['withheld',/withheld/]])test('candidate '+state+' bypasses the transfer interval and suppresses its obsolete pending progress',async t=>{
 const f=fixture();await f.initial();const clock=announcementClock(t),observed=observeRequestAnnouncements(f);await publishCandidates(f,candidateObservation('received'));await clock.advance(1);await publishCandidates(f,candidateObservation('downloaded'));const before=observed.changes.length;await clock.advance(1);await publishCandidates(f,candidateObservation(state));const terminal=requestAnnouncement(f);assert.match(terminal,message);assert.equal(observed.changes.length,before+1);await clock.advance(10000);assert.equal(requestAnnouncement(f),terminal);assert.equal(observed.changes.length,before+1);assert.deepEqual(observed.focus,[]);
});
for(const boundary of ['session','document'])test('pending transfer progress is discarded when its '+boundary+' owner changes',async t=>{
 const f=fixture();await f.initial();const clock=announcementClock(t),observed=observeRequestAnnouncements(f);await publishCandidates(f,candidateObservation('received'));await clock.advance(1);await publishCandidates(f,candidateObservation('downloaded'));if(boundary==='session')f.editor.sessionId='new-session';else f.editor.view.document={id:'new-document',revision:'1'};f.editor.json=async()=>({items:[]});await f.instance.sync();f.host.requestUpdate();await flush();assert.equal(requestAnnouncement(f),'');const before=observed.changes.length;await clock.advance(10000);assert.equal(requestAnnouncement(f),'');assert.equal(observed.changes.length,before);assert.deepEqual(observed.focus,[]);
});

const pageTwo='older / page?one',pageThree='oldest:page';
function queuePage(job,nextCursor){const view=queueObservation();view.totalJobs=3;view.jobs[0].id=job;view.jobs[0].attempts[0].id='attempt-'+job;view.jobs[0].attempts[0].requestId=null;view.nextCursor=nextCursor;return view;}
function pageControl(f,id){const template=find(f.template(),'<en-button id="'+id+'"');assert(template,'Rendered persistent '+id);const disabled=template.strings.findIndex(part=>part.includes('?disabled='));assert(disabled>=0,'Rendered disabled state '+id);return {disabled:template.values[disabled],click:template.values.find(value=>typeof value==='function')};}
function pageNumber(f){const status=find(f.template(),'id="queue-page-status"');assert(status);return status.values[0];}
function pendingPage(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
async function paginationFixture(t){
 const f=fixture();await f.initial();t.mock.timers.enable({apis:['setTimeout']});const pages=new Map([['',queuePage('newest',pageTwo)],[pageTwo,queuePage('middle',pageThree)],[pageThree,queuePage('oldest',null)]]),reads=[],commands=[],observed=observeRequestAnnouncements(f);let reader=null,events=[];
 const defaultRead=path=>{const cursor=path.includes('?after=')?decodeURIComponent(path.split('?after=')[1]):'';assert(pages.has(cursor),'Known retained queue cursor');return structuredClone(pages.get(cursor));};
 f.editor.json=async path=>{if(!path.startsWith('/api/v1/queue'))return {items:[]};reads.push(path);return reader?reader(path):defaultRead(path);};f.editor.command=async body=>{commands.push(structuredClone(body));return events;};
 const advance=async ms=>{t.mock.timers.tick(ms);await flush();},click=async id=>{const button=pageControl(f,id);assert.equal(button.disabled,false,'Enabled '+id);button.click(event());await advance(0);};
 await f.instance.refreshQueue();await flush();return {...f,pages,reads,commands,focus:observed.focus,advance,click,defaultRead,setReader:value=>reader=value,setEvents:value=>events=value};
}

test('queue navigation keeps persistent edge controls and restores First and Previous page history',async t=>{
 const f=await paginationFixture(t);assert.equal(pageNumber(f),1);assert.equal(pageControl(f,'queue-first').disabled,true);assert.equal(pageControl(f,'queue-previous').disabled,true);assert.equal(pageControl(f,'queue-next').disabled,false);
 await f.click('queue-next');assert.equal(f.reads.at(-1),'/api/v1/queue?after='+encodeURIComponent(pageTwo));assert.equal(pageNumber(f),2);assert.equal(f.instance.queue.jobs[0].id,'middle');assert.equal(pageControl(f,'queue-first').disabled,false);assert.equal(pageControl(f,'queue-previous').disabled,false);
 await f.click('queue-next');assert.equal(pageNumber(f),3);assert.equal(f.instance.queue.jobs[0].id,'oldest');assert.equal(pageControl(f,'queue-next').disabled,true);
 await f.click('queue-previous');assert.equal(pageNumber(f),2);assert.equal(f.instance.queue.jobs[0].id,'middle');await f.click('queue-first');assert.equal(pageNumber(f),1);assert.equal(f.reads.at(-1),'/api/v1/queue');assert.equal(pageControl(f,'queue-previous').disabled,true);
 assert.deepEqual(f.focus,Array(4).fill('#queue-page-status'));assert.deepEqual(f.commands,[]);
});

test('queue polling, explicit refresh and a settled public command retain the current page without moving focus',async t=>{
 const f=await paginationFixture(t);await f.click('queue-next');const path='/api/v1/queue?after='+encodeURIComponent(pageTwo),focus=[...f.focus],before=f.reads.length;await f.advance(150);
 assert.equal(f.reads.length,before+1);assert.equal(f.reads.at(-1),path);assert.equal(pageNumber(f),2);assert.deepEqual(f.focus,focus);
 actionById(f,'refresh-queue')(event());await f.advance(0);assert.equal(f.reads.at(-1),path);assert.deepEqual(f.focus,focus);
 const field=find(f.template(),'<en-number-field id="request-cap"'),control={value:'9',isConnected:true};field.values.filter(value=>typeof value==='function')[1](capEvent(control));await flush();actionById(f,'set-request-cap')(event());await f.advance(0);
 assert.deepEqual(f.commands,[{type:'SetSpendGuard',spendSessionId:'spend-session',expectedConfigVersion:'1',cap:9}]);assert.equal(f.reads.at(-1),path);assert.equal(f.instance.queue.jobs[0].id,'middle');assert.equal(pageNumber(f),2);assert.deepEqual(f.focus,focus);
});

test('a late first-page refresh cannot overwrite an explicitly selected later page',{timeout:5000},async t=>{
 const f=await paginationFixture(t),old=pendingPage();f.setReader(path=>path==='/api/v1/queue'?old.promise:f.defaultRead(path));const pending=f.instance.refreshQueue();void pending.catch(()=>{});
 try{await f.click('queue-next');assert.equal(f.instance.queue.jobs[0].id,'middle');assert.equal(pageNumber(f),2);
  old.resolve(f.defaultRead('/api/v1/queue'));await assert.rejects(pending,{name:'AbortError'});await flush();assert.equal(f.instance.queue.jobs[0].id,'middle');assert.equal(pageNumber(f),2);assert.deepEqual(f.focus,['#queue-page-status']);assert.equal(f.instance.queueNavigating,false);
 }finally{old.resolve(f.defaultRead('/api/v1/queue'));await Promise.allSettled([pending]);}
});
for(const queued of [false,true])test('a replaced queue model refuses its old navigation callback '+queued,{timeout:5000},async t=>{
 const f=await paginationFixture(t),old=pageControl(f,'queue-next').click;if(queued)old(event());
 await f.instance.refreshQueue();await flush();const reads=f.reads.length;if(!queued)old(event());await f.advance(0);
 assert.equal(f.reads.length,reads,'A retired queue callback cannot issue another read');assert.equal(pageNumber(f),1);assert.equal(f.instance.queue.jobs[0].id,'newest');assert.deepEqual(f.focus,[]);assert.equal(f.instance.queueNavigating,false);
});

test('operation replacement rejects a pending navigation and releases its navigation busy state',{timeout:5000},async t=>{
 const f=await paginationFixture(t),next=pendingPage();f.setReader(path=>path.includes('?after=')?next.promise:f.defaultRead(path));try{await f.click('queue-next');assert.equal(f.instance.queueNavigating,true);for(const id of ['queue-first','queue-previous','queue-next'])assert.equal(pageControl(f,id).disabled,true);
 const reads=f.reads.length;await f.instance.refreshQueue();assert.equal(f.reads.length,reads,'Background refresh cannot overtake active navigation');f.instance.operationChanged('Generate with Fast');next.resolve(f.pages.get(pageTwo));await flush();assert.equal(f.instance.queueNavigating,false);assert.equal(f.instance.queue.jobs[0].id,'newest');assert.equal(pageNumber(f),1);assert.equal(pageControl(f,'queue-next').disabled,false);assert.deepEqual(f.focus,[]);
 }finally{next.resolve(f.pages.get(pageTwo));await flush();}
});

for(const boundary of ['owner','document'])test('queue '+boundary+' replacement resets page history and fences old navigation cleanup from the new owner',{timeout:5000},async t=>{
 const f=await paginationFixture(t),old=pendingPage(),current=pendingPage();try{await f.click('queue-next');f.setReader(path=>path.includes('?after=')?old.promise:f.defaultRead(path));await f.click('queue-next');assert.equal(f.instance.queueNavigating,true);
 if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};else f.editor.view.document={id:'replacement-document',revision:'1'};await f.instance.sync();await flush();assert.equal(f.instance.queue,null);assert.deepEqual(f.instance.queueBack,[]);assert.equal(f.instance.queueCursor,'');assert.equal(f.instance.queueNavigating,false);
 f.setReader(path=>path.includes('?after=')?current.promise:f.defaultRead(path));await f.instance.refreshQueue();await flush();await f.click('queue-next');const focus=[...f.focus];old.resolve(f.pages.get(pageThree));await flush();assert.equal(f.instance.queueNavigating,true,'Old completion cannot clear the new navigation');assert.equal(f.instance.queue.jobs[0].id,'newest');assert.deepEqual(f.focus,focus);
 current.resolve(f.pages.get(pageTwo));await flush();assert.equal(f.instance.queueNavigating,false);assert.equal(f.instance.queue.jobs[0].id,'middle');assert.equal(pageNumber(f),2);assert.deepEqual(f.focus,[...focus,'#queue-page-status']);
 }finally{old.resolve(f.pages.get(pageThree));current.resolve(f.pages.get(pageTwo));await flush();}
});

test('later-page new jobs status follows a true total increase and First clears it',async t=>{
 const f=await paginationFixture(t);await f.click('queue-next');assert.equal(find(f.template(),'id="queue-new-jobs"'),undefined);f.pages.get(pageTwo).jobs[0].version='2';await f.instance.refreshQueue();await flush();assert.equal(find(f.template(),'id="queue-new-jobs"'),undefined,'A metadata version change is not a new job');
 f.pages.get(pageTwo).totalJobs=4;await f.instance.refreshQueue();await flush();assert(find(f.template(),'id="queue-new-jobs"'));assert.equal(pageNumber(f),2);assert.deepEqual(f.focus,['#queue-page-status']);await f.click('queue-first');assert.equal(find(f.template(),'id="queue-new-jobs"'),undefined);assert.equal(pageNumber(f),1);
});

test('a local queued receipt flags new jobs while retaining the later page even without a changed total',async t=>{
 const f=await paginationFixture(t);await f.click('queue-next');f.setEvents([{type:'JobQueued',payload:{}}]);await f.instance.queueCommand({type:'QueueInference',reviewId:'review',token:'token',acceptanceId:'accepted'});await flush();assert(find(f.template(),'id="queue-new-jobs"'));assert.equal(pageNumber(f),2);assert.equal(f.instance.queue.jobs[0].id,'middle');assert.equal(f.reads.at(-1),'/api/v1/queue?after='+encodeURIComponent(pageTwo));assert.deepEqual(f.focus,['#queue-page-status']);
});


test('prompt admission refusal preserves exact native input and the previous saved generation',async()=>{
 const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL),f=fixture();await f.initial();f.prompt()(f.promptEvent('saved'));await flush();const count=f.saved.length,refused=[],recordRefusal=f.editor.draftOwner.refuseChange.bind(f.editor.draftOwner);f.editor.draftOwner.refuseChange=(id,documentId)=>{recordRefusal(id,documentId);refused.push({id,documentId});};
 const pressure=allocationLedger.reserve({owner:'request-test-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes});
 try{f.prompt()(f.promptEvent('complete unsaved input'));await flush();assert.equal(f.saved.length,count);assert.equal(find(f.template(),'<en-textarea id="prompt"').values[1],'complete unsaved input');assert.equal(refused.length,1);assert.equal(refused[0].documentId,'doc');assert.match(JSON.stringify(f.template()),/previous saved draft is retained/);}finally{pressure.release();}
 f.prompt()(f.promptEvent('complete unsaved input'));await flush();assert.equal(JSON.parse(f.saved.at(-1).text).text,'complete unsaved input');
});
test('operation clone is admitted before changing the current prompt owner',async()=>{
 const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL),f=fixture();await f.initial();f.prompt()(f.promptEvent('source'));await flush();const pressure=allocationLedger.reserve({owner:'request-test-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes});
 try{assert.throws(()=>f.instance.operationChanged('Generate with Instant'),/PROMPT_MEMORY_BUDGET/);assert.equal(f.instance.operation,'Generate image');assert.equal(find(f.template(),'<en-textarea id="prompt"').values[1],'source');}finally{pressure.release();}
});


test('request document release waits for an aborted prompt body cancellation to settle',{timeout:5000},async()=>{
 const {allocationLedger}=await import(allocationsURL),f=fixture();await f.initial();
 // Retained Entry payloads are also prompt owners; isolate this reader's 20 bytes.
 const retainedPromptBytes=allocationLedger.snapshot().byKind.prompt.cpuBytes;
 let entered,finishCancellation,cancels=0;const reading=new Promise(resolve=>entered=resolve),cancellation=new Promise(resolve=>finishCancellation=resolve);
 const body=new ReadableStream({pull(){entered();},cancel(){cancels++;return cancellation;}},{highWaterMark:0});
 f.editor.session.transport=async()=>new Response(body);
 const read=f.instance.readPromptBody('/retained-prompt',5,()=>true),rejected=assert.rejects(read,/PROMPT_READ_STALE/);await reading;
 assert.equal(allocationLedger.snapshot().byKind.prompt.cpuBytes,retainedPromptBytes+20);
 let released=false;const release=f.instance.releaseDocument().then(()=>{released=true;});await flush();
 assert.equal(cancels,1);assert.equal(released,false);assert.equal(allocationLedger.snapshot().byKind.prompt.cpuBytes,20,'The pending native cancellation still owns its reservation');
 finishCancellation();await rejected;await release;
 assert.equal(released,true);assert.equal(body.locked,false);assert.equal(allocationLedger.snapshot().byKind.prompt.cpuBytes,0);
});


// Contextual adapter actions use the same explicit per-operation draft switch
// as the main selector, with public disclosure focus after current-owner render.
for(const [origin,target] of [['Transform image','Transform with adapters'],['Edit masked region','Edit with adapters']])test('contextual Use adapters preserves both exact '+origin+' drafts and focuses the public library',async()=>{
 const changes=[],focus=[],calls=[],f=fixture(value=>changes.push(value));await f.initial();f.instance.operationChanged(origin);await flush();
 f.prompt()(f.promptEvent('Original '+origin));await flush();find(f.template(),'<en-text-field id="request-seed"').values.find(v=>typeof v==='function')(event('invalid seed retained'));await flush();
 const prior=structuredClone(f.instance.entry()),library={isConnected:true,open:false,updateComplete:Promise.resolve(),requestOpen(value){calls.push(value);this.open=value;},focus(){focus.push('library');}},query=f.host.querySelector.bind(f.host);
 f.host.querySelector=selector=>selector==='#request-adapters'?library:query(selector);const commands=[];f.editor.command=async body=>{commands.push(body);return [];};
 await act(f,'request-use-adapters');assert.equal(f.instance.operation,target);assert.deepEqual(changes,[target]);assert.deepEqual(calls,[true]);assert.deepEqual(focus,['library']);
 assert.deepEqual([...f.instance.entries.values()].find(entry=>entry.id===prior.id),prior,'Origin draft is byte-for-byte retained');
 const copied=f.instance.entry();assert.notEqual(copied.id,prior.id);assert.equal(copied.text,prior.text);assert.deepEqual(copied.draft.fields,prior.draft.fields);assert.deepEqual(copied.draft.source,prior.draft.source);assert.deepEqual(copied.draft.mask,prior.draft.mask);assert.deepEqual(copied.draft.adapters,prior.draft.adapters);assert.deepEqual(commands,[]);assert.deepEqual(f.reviews,[]);
 assert.equal(find(f.template(),'<en-button id="request-use-adapters"'),undefined,'The adapter operation does not offer another implicit route');
 f.prompt()(f.promptEvent('Existing adapter draft'));await flush();const retained=structuredClone(f.instance.entry());f.instance.operationChanged(origin);await flush();assert.deepEqual(f.instance.entry(),prior);
 await act(f,'request-use-adapters');assert.deepEqual(f.instance.entry(),retained,'An existing destination draft is selected, never overwritten with origin settings');assert.deepEqual(changes,[target,target]);assert.deepEqual(commands,[]);assert.deepEqual(f.reviews,[]);
});
for(const boundary of ['edit','operation','owner','veto','detach','composing'])test('contextual Use adapters refuses stale or canceled '+boundary+' activation',async()=>{
 const changes=[],f=fixture(value=>changes.push(value));await f.initial();f.instance.operationChanged('Transform image');await flush();const callback=actionById(f,'request-use-adapters'),e=event();
 if(boundary==='edit'){f.prompt()(f.promptEvent('New originating draft'));await flush();}
 if(boundary==='operation'){f.instance.operationChanged('Generate with Fast');await flush();}
 if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};
 if(boundary==='composing'){find(f.template(),'<section aria-label="Typed request draft"').values.filter(v=>typeof v==='function')[0]();await flush();}
 const before=f.instance.operation,saves=f.saved.length;callback(e);if(boundary==='veto')e.defaultPrevented=true;if(boundary==='detach')e.currentTarget.isConnected=false;await tick();await flush();
 assert.equal(f.instance.operation,before);assert.equal(f.saved.length,saves);assert.deepEqual(changes,[]);assert.deepEqual(f.reviews,[]);
});
for(const boundary of ['operation','owner','removed','vetoed-open'])test('contextual adapter disclosure cannot take focus after '+boundary,async()=>{
 const focus=[],f=fixture();await f.initial();f.instance.operationChanged('Edit masked region');await flush();let release;const completed=new Promise(resolve=>release=resolve),library={isConnected:true,open:false,updateComplete:completed,requestOpen(value){this.open=boundary==='vetoed-open'?false:value;},focus(){focus.push('library');}},query=f.host.querySelector.bind(f.host);
 f.host.querySelector=selector=>selector==='#request-adapters'?library:query(selector);actionById(f,'request-use-adapters')(event());await tick();await flush();assert.equal(f.instance.operation,'Edit with adapters');
 if(boundary==='operation')f.instance.operationChanged('Generate image');if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};if(boundary==='removed')library.isConnected=false;release();await tick();await flush();assert.deepEqual(focus,[]);assert.deepEqual(f.reviews,[]);
});


test('contextual masked adapter action preserves actual source and mask refs attached through public controls',async()=>{
 const f=await maskController();await act(f,'request-source');await act(f,'request-mask');
 const prior=structuredClone(f.instance.entry());assert.equal(prior.draft.source.assetId,'source');assert.equal(prior.draft.mask.assetId,'mask');assert.equal(prior.draft.mask.sourceHash,prior.draft.source.pixels.hash);assert.equal(prior.draft.adapters.length,0);
 const commands=[];f.editor.command=async body=>{commands.push(body);return [];};await act(f,'request-use-adapters');const selected=f.instance.entry();
 assert.equal(f.instance.operation,'Edit with adapters');assert.notEqual(selected.id,prior.id);assert.deepEqual(selected.draft.source,prior.draft.source);assert.deepEqual(selected.draft.mask,prior.draft.mask);assert.deepEqual(selected.draft.requestMaskDraft,prior.draft.requestMaskDraft);assert.deepEqual(selected.draft.conversion,prior.draft.conversion);assert.deepEqual(selected.draft.adapters,[],'Choosing the route does not fabricate an eligible adapter');
 assert.deepEqual([...f.instance.entries.values()].find(entry=>entry.id===prior.id),prior);assert.deepEqual(commands,[]);assert.deepEqual(f.reviews,[]);
 f.instance.operationChanged('Edit masked region');await flush();assert.deepEqual(f.instance.entry(),prior);
});

// These turns mirror the shell's repeated sync after unrelated view/render
// updates. The controller, owned reads and restoration work remain real.
async function restoreRenderTurns(f,count){
 for(let index=0;index<count;index++){
  f.editor.view={...f.editor.view,document:{...f.editor.view.document},message:'Unrelated view update '+index};
  f.host.requestUpdate();await f.host.updateComplete;await f.instance.sync();
 }
 await flush();
}
async function restoreAuthorityChange(f,boundary){
 if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};
 else if(boundary==='session')f.editor.sessionId='replacement-session';
 else if(boundary==='identity')f.identity('replacement-client');
 else if(boundary==='connection')f.editor.session={...f.editor.session};
 else if(boundary==='document')f.editor.view.document={id:'replacement-document',revision:'1'};
 else if(boundary==='revision')f.editor.view.document={...f.editor.view.document,revision:'2'};
 else if(boundary==='documentEpoch')f.editor.documentEpoch++;
 else if(boundary==='ready'){f.editor.view.ready=false;await f.instance.sync();f.editor.view.ready=true;}
 else if(boundary==='Open')await f.instance.releaseDocument();
 else assert.fail('Unknown restoration boundary');
}
function assertRestoreWorkDrained(f){
 const memory=f.instance.inspectMemory();
 for(const key of ['entryTasks','entryHolds','entryReads','promptReads','retiredEntries'])assert.equal(memory[key],0,key);
 assert.equal(memory.navigation.controls.reads,0);assert.equal(memory.navigation.controls.pending,0);
}

test('failed initial request history restore reports once across concurrent and repeated render syncs',{timeout:5000},async()=>{
 const f=fixture(),failure=Error('STORAGE_FULL'),failures=[];let reads=0,rejectRead,pins=0,releases=0,registrations=0;
 const heldRead=new Promise((_resolve,reject)=>rejectRead=reject);
 const pin=f.editor.pinUI.bind(f.editor),register=f.editor.registerDraft.bind(f.editor);
 f.editor.pinUI=()=>{pins++;const release=pin();return ()=>{releases++;release();};};
 f.editor.registerDraft=(...args)=>{registrations++;return register(...args);};
 f.editor.json=path=>{assert.equal(path,'/api/v1/ui/session/request-reviews');reads++;return heldRead;};
 const report=error=>{failures.push(error);f.editor.view={...f.editor.view,error:error.message};f.host.requestUpdate();};
 const pending=[f.instance.sync().catch(report)];
 try{await flush();pending.push(...Array.from({length:16},()=>f.instance.sync().catch(report)));await flush();
 assert.equal(reads,1);rejectRead(failure);await Promise.all(pending);await flush();
 assert.deepEqual(failures,[failure]);assert.equal(pins,1);assert.equal(releases,1);assert.equal(registrations,0);
 await restoreRenderTurns(f,32);
 assert.equal(reads,1);assert.deepEqual(failures,[failure]);assert.equal(pins,1);assert.equal(releases,1);assert.equal(registrations,0);
 assert.equal(f.instance.inspectMemory().entries,0);assert.equal(f.saved.length,0);assertRestoreWorkDrained(f);
 }finally{rejectRead(Error('fixture cleanup'));await Promise.allSettled(pending);}
});

for(const boundary of ['owner','session','identity','connection','document','revision','documentEpoch','ready','Open'])test('failed initial request restore retries after an actual '+boundary+' transition',async()=>{
 const f=fixture(),failure=Error('STORAGE_FULL');let reads=0,failed=true;
 f.editor.json=async path=>{assert(path.endsWith('/request-reviews'));reads++;if(failed)throw failure;return {items:[]};};
 await assert.rejects(f.instance.sync(),error=>error===failure);await restoreRenderTurns(f,20);assert.equal(reads,1);
 failed=false;await restoreRenderTurns(f,10);assert.equal(reads,1,'Transport recovery alone does not authorize another render retry');
 await restoreAuthorityChange(f,boundary);await f.instance.sync();await flush();
 assert.equal(reads,2);assert.equal(f.instance.owner,f.editor.draftOwner);assert.equal(f.instance.documentId,f.editor.view.document.id);
 assert.equal(f.instance.entry().revision,f.editor.view.document.revision);assert.equal(f.instance.inspectMemory().entries,1);
 await restoreRenderTurns(f,10);assert.equal(reads,2);assertRestoreWorkDrained(f);
});

test('a permitted request restore retry can fail once again and recover on a later explicit Open',async()=>{
 const f=fixture(),failures=[Error('STORAGE_FULL'),Error('LOCAL_SERVER_UNAVAILABLE')];let reads=0;
 f.editor.json=async()=>{const failure=failures[reads++];if(failure)throw failure;return {items:[]};};
 await assert.rejects(f.instance.sync(),error=>error===failures[0]);await restoreRenderTurns(f,20);assert.equal(reads,1);
 await restoreAuthorityChange(f,'ready');await assert.rejects(f.instance.sync(),error=>error===failures[1]);
 await restoreRenderTurns(f,10);assert.equal(reads,2);assert.equal(f.instance.inspectMemory().entries,0);
 await restoreAuthorityChange(f,'Open');await f.instance.sync();await flush();assert.equal(reads,3);assert.equal(f.instance.inspectMemory().entries,1);assertRestoreWorkDrained(f);
});

test('a transient ready=false observation permits retry before queued sync work resumes',async()=>{
 const f=fixture(),failure=Error('STORAGE_FULL');let reads=0;
 f.editor.json=async()=>{if(++reads===1)throw failure;return {items:[]};};
 await assert.rejects(f.instance.sync(),error=>error===failure);
 f.editor.view.ready=false;const reconnect=f.instance.sync();f.editor.view.ready=true;
 await reconnect;await flush();assert.equal(reads,2);assert.equal(f.instance.inspectMemory().entries,1);
 await restoreRenderTurns(f,10);assert.equal(reads,2);assertRestoreWorkDrained(f);
});

for(const boundary of ['owner','session','identity','connection','document','revision','documentEpoch','ready'])test('late initial request failure cannot fence the restored '+boundary+' successor',{timeout:5000},async()=>{
 const f=fixture();let reads=0,rejectOld;
 f.editor.json=async()=>{if(++reads===1)return new Promise((_resolve,reject)=>rejectOld=reject);return {items:[]};};
 const pending=f.instance.sync();
 try{await flush();assert.equal(typeof rejectOld,'function');
 await restoreAuthorityChange(f,boundary);await f.instance.sync();await flush();const successor=f.instance.entry();assert(successor);assert.equal(reads,2);
 rejectOld(Error('old STORAGE_FULL'));await pending;await restoreRenderTurns(f,10);
 assert.equal(reads,2);assert.equal(f.instance.entry(),successor);assert.equal(f.instance.owner,f.editor.draftOwner);assertRestoreWorkDrained(f);
 }finally{rejectOld?.(Error('fixture cleanup'));await pending.catch(()=>{});}
});

for(const boundary of ['releaseDocument','dispose'])test('request '+boundary+' drains a pending failed restore and prevents its publication',{timeout:5000},async()=>{
 const f=fixture();let reads=0,rejectRead,closed=false,closing;
 f.editor.json=async()=>{reads++;return new Promise((_resolve,reject)=>rejectRead=reject);};
 const pending=f.instance.sync();
 try{await flush();assert.equal(typeof rejectRead,'function');
 closing=f.instance[boundary]().then(()=>{closed=true;});await flush();assert.equal(closed,false);
 await f.instance.sync();assert.equal(reads,1);rejectRead(Error('old STORAGE_FULL'));await pending;await closing;await flush();
 assert.equal(closed,true);assert.equal(f.instance.inspectMemory().entries,0);assertRestoreWorkDrained(f);
 f.editor.json=async()=>{reads++;return {items:[]};};await f.instance.sync();await flush();
 assert.equal(reads,boundary==='dispose'?1:2);assert.equal(f.instance.inspectMemory().entries,boundary==='dispose'?0:1);
 }finally{rejectRead?.(Error('fixture cleanup'));await pending.catch(()=>{});await closing?.catch(()=>{});}
});

test('initial request admission failure stays bounded after capacity returns until reconnect',async()=>{
 const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL),f=fixture();let reads=0,pins=0;
 const pin=f.editor.pinUI.bind(f.editor);f.editor.pinUI=()=>{pins++;return pin();};f.editor.json=async()=>{reads++;return {items:[]};};
 const pressure=allocationLedger.reserve({owner:'request-restore-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes});
 try{await assert.rejects(f.instance.sync(),/PROMPT_MEMORY_BUDGET/);await restoreRenderTurns(f,10);assert.equal(pins,1);assert.equal(reads,0);}finally{pressure.release();}
 await restoreRenderTurns(f,10);assert.equal(pins,1);assert.equal(reads,0);assert.equal(f.instance.inspectMemory().entries,0);assertRestoreWorkDrained(f);
 await restoreAuthorityChange(f,'ready');await f.instance.sync();await flush();assert.equal(pins,2);assert.equal(reads,1);assert.equal(f.instance.inspectMemory().entries,1);
});

test('loaded request synchronization remains live after a downstream edit synchronization failure',async()=>{
 const f=fixture(),failure=Error('edit synchronization failed');let reads=0,syncs=0,previews=0;
 f.editor.json=async()=>{reads++;return {items:[]};};
 const sync=f.instance.requestEdits.sync.bind(f.instance.requestEdits),preview=f.instance.preview.bind(f.instance);
 f.instance.requestEdits.sync=async()=>{await sync();if(++syncs===1)throw failure;};
 f.instance.preview=async()=>{previews++;return preview();};
 await assert.rejects(f.instance.sync(),error=>error===failure);const entry=f.instance.entry();assert(entry);
 await f.instance.sync();await flush();assert.equal(reads,1);assert.equal(syncs,2);assert.equal(previews,2);assert.equal(f.instance.entry(),entry);assertRestoreWorkDrained(f);
});

test('initial saved request cleanup refusal is retained until document release retries the actual reader',{timeout:5000},async()=>{
 const donor=fixture();await donor.initial();const draft=structuredClone(donor.instance.entry().draft);
 const f=fixture(undefined,[{kind:'request',id:'saved-request',documentId:'doc',generation:'1',expectedDocumentRevision:'1'}]);
 let metadataReads=0,promptReads=0,historyReads=0,refuse=true,locked=true,cancels=0;
 const reader={async read(){return {done:true};},async cancel(){cancels++;},releaseLock(){if(refuse)throw Error('native unlock refused');locked=false;}};
 f.editor.json=async path=>{if(path.endsWith('/request-reviews')){historyReads++;return {items:[]};}assert(path.includes('draftId=saved-request'));metadataReads++;return {value:draft};};
 f.editor.session.transport=async path=>{assert(path.endsWith('&content=1'));promptReads++;return {ok:true,headers:new Headers({'content-length':'0'}),body:{getReader:()=>reader}};};
 try{
 await assert.rejects(f.instance.sync(),/PROMPT_READER_CLEANUP_FAILED/);await flush();
 assert.equal(locked,true);assert.equal(cancels,1);assert.equal(f.instance.inspectMemory().entryCleanup,1);assert.equal(f.instance.inspectMemory().entries,0);
 await restoreRenderTurns(f,10);assert.deepEqual([metadataReads,promptReads,historyReads],[1,1,0]);
 await assert.rejects(f.instance.releaseDocument(),/REQUEST_RELEASE_INCOMPLETE/);await flush();assert.equal(locked,true);assert.equal(f.instance.inspectMemory().entryCleanup,1);
 refuse=false;await f.instance.releaseDocument();await flush();assert.equal(locked,false);assert.equal(f.instance.inspectMemory().entryCleanup,0);assertRestoreWorkDrained(f);
 f.editor.session.transport=async()=>{promptReads++;return new Response('',{headers:{'content-length':'0'}});};
 await f.instance.sync();await flush();assert.equal(f.instance.entry().id,'saved-request');assert.deepEqual([metadataReads,promptReads,historyReads],[2,2,1]);assertRestoreWorkDrained(f);
 }finally{refuse=false;await f.instance.releaseDocument();}
});


// These cases use the actual two Request controllers, display reader/scheduler,
// response admission and URL ownership. Only transport and native PNG decode
// are fixture boundaries; they do not qualify browser pixels or server caching.
const previewDeferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const previewHash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
function previewPNG(){
 const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;};
 const chunk=(name,bytes)=>{const type=Buffer.from(name),out=Buffer.alloc(bytes.length+12);out.writeUInt32BE(bytes.length);type.copy(out,4);bytes.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([type,bytes])),bytes.length+8);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(3);header.writeUInt32BE(2,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(26))),chunk('IEND',Buffer.alloc(0))]);
}
function previewProjection(id){const projection=assetProjection(id),asset=projection.projection.value;asset.blob.hash=previewHash(id+'-encoded');asset.raster.pixels.hash=previewHash(id+'-pixels');asset.raster.pixelIdentity=asset.raster.pixels.hash;asset.raster.manifest.hash=previewHash(id+'-manifest');return projection;}
function previewSource(id){const asset=previewProjection(id).projection.value;return {assetId:id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:3,height:2,scope:'asset',documentRevision:'1'};}
async function previewController(t,{restore=false,gateAt=1,holdCancellation=false}={}){
 const savedDraft=newDraft({hash:previewHash(''),byteLength:'0',mediaType:'text/plain'});savedDraft.source=previewSource('source');
 const f=fixture(undefined,restore?[{id:'saved-preview',kind:'request',documentId:'doc',generation:'1',expectedDocumentRevision:'1'}]:[]),reads=[],created=[],revoked=[],errors=[],children=[],work=[],cancelGate=previewDeferred(),entered=previewDeferred();
 let rendition=0,cancels=0,gateController,gateClosed=false;
 const bytes=previewPNG(),oldBitmap=Object.getOwnPropertyDescriptor(globalThis,'createImageBitmap');
 Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,writable:true,value:async blob=>{const value=Buffer.from(await blob.arrayBuffer());assert.deepEqual(value,bytes);const n=value.readUInt32BE(33),compressed=value.subarray(41,41+n);assert.equal(inflateSync(compressed).length,26);return {width:3,height:2,close(){}};}});
 t.mock.method(URL,'createObjectURL',()=>{const url='blob:request-source-pair-'+created.length;created.push(url);return url;});
 t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url));
 const track=promise=>{work.push(promise);void promise.catch(()=>{});return promise;};
 const finish=()=>{if(gateController&&!gateClosed){gateClosed=true;gateController.enqueue(bytes);gateController.close();}};
 t.after(async()=>{finish();cancelGate.resolve();try{await f.instance.dispose();await Promise.allSettled(work);await flush();assertRestoreWorkDrained(f);assert.equal(displayPreviewOwnership().activeReads,0);assert.equal(displayPreviewOwnership().previewURLs,0);assert.deepEqual(revoked.slice().sort(),created.slice().sort(),'Every independently owned preview URL releases exactly once');}finally{if(oldBitmap)Object.defineProperty(globalThis,'createImageBitmap',oldBitmap);else delete globalThis.createImageBitmap;}});
 f.instance.error=error=>errors.push(error);
 f.editor.json=async path=>path.endsWith('/request-reviews')?{items:[]}:path.includes('/request?')?{value:savedDraft}:previewProjection(path.split('/').at(-1));
 f.editor.session.transport=async(path,init)=>{
  if(path.includes('/request?')&&path.endsWith('&content=1'))return new Response('',{headers:{'content-length':'0'}});
  const url=new URL(path,'http://127.0.0.1'),match=/^\/api\/v1\/assets\/([A-Za-z0-9_-]+)(\/display)?$/.exec(url.pathname);assert(match,'Only source descriptor/rendition reads: '+path);
  const projection=previewProjection(match[1]),asset=projection.projection.value;reads.push({path,signal:init?.signal,identity:f.editor.session.identity()});
  if(!match[2]){const json=JSON.stringify(projection);return new Response(json,{headers:{'content-length':String(Buffer.byteLength(json))}});}
  assert.equal(path,displayPath(asset.id,{kind:'preview',basis:'pixels',identity:asset.raster.pixelIdentity,edge:1024}));
  const headers={'content-type':'image/png','content-length':String(bytes.length),etag:'"'+previewHash(bytes)+'"',[DISPLAY_HEADERS.profile]:DISPLAY_PROFILE,[DISPLAY_HEADERS.source]:asset.raster.pixelIdentity,[DISPLAY_HEADERS.basis]:'pixels',[DISPLAY_HEADERS.width]:'3',[DISPLAY_HEADERS.height]:'2',[DISPLAY_HEADERS.sourceWidth]:'3',[DISPLAY_HEADERS.sourceHeight]:'2',[DISPLAY_HEADERS.lod]:'0'};
  if(++rendition!==gateAt)return new Response(bytes,{headers});
  const body=new ReadableStream({start(controller){gateController=controller;},cancel(){cancels++;gateClosed=true;return holdCancellation?cancelGate.promise:undefined;}});
  const response=new Response(body,{headers});entered.resolve();return response;
 };
 if(!restore){await f.initial();f.instance.mutateEntry(previewSource('source'),next=>{next.draft.source=previewSource('source');});await flush();}
 const sync=f.instance.requestEdits.sync.bind(f.instance.requestEdits);
 f.instance.requestEdits.sync=()=>{children.push({entry:f.instance.entry(),identity:f.editor.session.identity()});return sync();};
 return {...f,reads,created,revoked,errors,children,entered:entered.promise,finish,fail:error=>{assert(gateController&&!gateClosed);gateClosed=true;gateController.error(error);},cancelGate,cancels:()=>cancels,start:()=>track(f.instance.sync()),track,renditions:()=>reads.filter(row=>row.path.includes('/display?'))};
}

for(const leg of ['source','child'])test('request preview pair joins repeated renders during the '+leg+' read',async t=>{
 const f=await previewController(t,{gateAt:leg==='source'?1:2}),first=f.start();await f.entered;await flush();
 const joined=Array.from({length:16},()=>f.start());await flush();
 assert.equal(f.renditions().length,leg==='source'?1:2);assert.equal(f.children.length,leg==='source'?0:1);assert.equal(f.created.length,leg==='source'?0:1);
 f.finish();await Promise.all([first,...joined]);await flush();assert.equal(f.renditions().length,2);assert.equal(f.children.length,1);assert.equal(f.created.length,2);assert.notEqual(f.instance.previewURL,f.instance.requestEdits.sourceURL);assert.deepEqual(f.errors,[]);
 await f.start();assert.equal(f.renditions().length,2,'Settled previews do not reread on an unrelated render');assertRestoreWorkDrained(f);
});

test('restored request publication joins the same preview pair as a render reentry',async t=>{
 const f=await previewController(t,{restore:true}),update=f.host.requestUpdate.bind(f.host);let reentry;
 f.host.requestUpdate=()=>{update();if(f.instance.loaded&&!reentry)reentry=f.start();};
 const initial=f.start();await f.entered;await flush();assert(reentry);assert.equal(f.renditions().length,1);assert.equal(f.children.length,0);
 f.finish();await Promise.all([initial,reentry]);assert.equal(f.instance.entry().id,'saved-preview');assert.equal(f.renditions().length,2);assert.equal(f.children.length,1);assert.deepEqual(f.errors,[]);
});

test('a changed request source cancels the old read before starting its own complete pair',async t=>{
 const f=await previewController(t),first=f.start();await f.entered;await flush();
 f.instance.mutateEntry(previewSource('next'),next=>{next.draft.source=previewSource('next');});const successor=f.start();await Promise.all([first,successor]);
 assert.equal(f.cancels(),1);assert.equal(f.renditions().length,3);assert.equal(f.renditions()[0].signal.aborted,true);assert(f.renditions().slice(1).every(row=>row.path.startsWith('/api/v1/assets/next/display?')));assert.equal(f.children.length,1);assert.equal(f.children[0].entry,f.instance.entry());assert.equal(f.created.length,2);assert.deepEqual(f.errors,[]);
});

test('an unrelated prompt generation joins the active source without canceling or rereading it',async t=>{
 const f=await previewController(t),first=f.start();await f.entered;await flush();
 f.instance.mutateEntry('later prompt',next=>{next.text='later prompt';});const successor=f.start();await flush();assert.equal(f.cancels(),0);assert.equal(f.renditions().length,1);assert.equal(f.children.length,0);
 f.finish();await Promise.all([first,successor]);assert.equal(f.renditions().length,2);assert.equal(f.children.length,1);assert.equal(f.children[0].entry,f.instance.entry());assert.equal(f.instance.entry().text,'later prompt');assert.deepEqual(f.errors,[]);
});

for(const boundary of ['identity','connection','revision'])test('same-entry request preview successor survives an authority-only '+boundary+' change',async t=>{
 const f=await previewController(t),first=f.start(),entry=f.instance.entry();await f.entered;await flush();
 if(boundary==='identity')f.identity('successor');else if(boundary==='connection')f.editor.session={...f.editor.session};else f.editor.view.document={...f.editor.view.document,revision:'2'};
 const successor=f.start();await Promise.all([first,successor]);assert.equal(f.instance.entry(),entry);assert.equal(f.cancels(),1);assert.equal(f.renditions().length,3);assert.equal(f.children.length,1);assert.equal(f.created.length,2);assert.deepEqual(f.errors,[]);
});

for(const boundary of ['dispose','releaseDocument'])for(const leg of ['source','child'])test('request preview '+boundary+' waits for canceled '+leg+' ownership without restarting the child',async t=>{
 const f=await previewController(t,{gateAt:leg==='source'?1:2,holdCancellation:true}),first=f.start();let joined,closing,closed=false;
 try{
  await f.entered;await flush();joined=f.start();assert.equal(f.created.length,leg==='source'?0:1);assert.deepEqual(f.revoked,[]);
  closing=f.track(f.instance[boundary]().then(()=>{closed=true;}));await flush();assert.equal(f.cancels(),1);assert.equal(closed,false);assert.equal(f.children.length,leg==='source'?0:1);assert(f.instance.inspectMemory().entryTasks>0);
  f.cancelGate.resolve();const results=await Promise.allSettled([first,joined,closing]);assert.equal(results[0].status,leg==='source'?'fulfilled':'rejected');if(leg==='child')assert.equal(results[0].reason.name,'AbortError');assert.equal(results[1].status,'fulfilled');assert.equal(results[2].status,'fulfilled');
  assert.equal(closed,true);assert.equal(f.children.length,leg==='source'?0:1);assert.equal(f.created.length,leg==='source'?0:1);assert.deepEqual(f.revoked,f.created);assert.deepEqual(f.errors,[]);assertRestoreWorkDrained(f);
 }finally{f.finish();f.cancelGate.resolve();await Promise.allSettled([first,joined,closing].filter(Boolean));}
});

test('one preview-pair failure is published once to concurrent renders and allows a later explicit sync',async t=>{
 const f=await previewController(t),failure=Error('child preview refused'),child=f.instance.requestEdits.sync.bind(f.instance.requestEdits),held=previewDeferred(),childEntered=previewDeferred();let calls=0,failures=0;const joined=[];
 f.instance.requestEdits.sync=async()=>{await child();if(++calls===1){childEntered.resolve();await held.promise;throw failure;}};
 const first=f.track(f.start().catch(error=>{assert.equal(error,failure);failures++;}));
 try{
  await f.entered;f.finish();await childEntered.promise;
  joined.push(...Array.from({length:16},()=>f.track(f.start().catch(()=>{failures++;}))));await flush();assert.equal(calls,1);held.resolve();await Promise.all([first,...joined]);assert.equal(failures,1);assert.equal(calls,1);assert.equal(f.renditions().length,2);
  await f.start();assert.equal(calls,2);assert.equal(f.renditions().length,2);assert.deepEqual(f.errors,[]);assertRestoreWorkDrained(f);
 }finally{f.finish();held.resolve();await Promise.allSettled([first,...joined]);}
});


test('a failed request source preview keeps its failure without render-driven rereads',async t=>{
 const f=await previewController(t),failure=Error('source preview refused'),first=f.start();await f.entered;await flush();const joined=Array.from({length:16},()=>f.start());await flush();
 f.fail(failure);await Promise.all([first,...joined]);assert.deepEqual(f.errors,[failure]);assert.equal(f.renditions().length,2);assert.equal(f.children.length,1);assert.equal(f.instance.previewURL,'');assert(f.instance.requestEdits.sourceURL);assert.equal(f.created.length,1);
 await Promise.all(Array.from({length:16},()=>f.start()));assert.equal(f.renditions().length,2);assert.deepEqual(f.errors,[failure]);assertRestoreWorkDrained(f);
});


test('a changed source waits through the old child read before its successor pair',async t=>{
 const f=await previewController(t,{gateAt:2}),first=f.start();await f.entered;await flush();
 f.instance.mutateEntry(previewSource('next'),next=>{next.draft.source=previewSource('next');});const successor=f.start();await flush();assert.equal(f.renditions().length,2);assert.equal(f.children.length,1);
 f.finish();await Promise.all([first,successor]);assert.equal(f.renditions().length,4);assert(f.renditions().slice(2).every(row=>row.path.startsWith('/api/v1/assets/next/display?')));assert.equal(f.children.length,2);assert.equal(f.children.at(-1).entry,f.instance.entry());assert.equal(f.created.length,4);assert.deepEqual(f.revoked,f.created.slice(0,2));assert.deepEqual(f.errors,[]);
});

test('a replacement request owner drains its predecessor preview before child synchronization',async t=>{
 const f=await previewController(t),first=f.start(),oldEntry=f.instance.entry();await f.entered;await flush();f.editor.draftOwner={drafts:new Map()};
 const successor=f.start();await Promise.all([first,successor]);assert.notEqual(f.instance.entry(),oldEntry);assert.equal(f.cancels(),1);assert.equal(f.children.length,1);assert.equal(f.children[0].entry,f.instance.entry());assert.equal(f.created.length,0);
 await f.instance.source('next','asset');await f.start();assert.equal(f.renditions().length,3);assert(f.renditions().slice(1).every(row=>row.path.startsWith('/api/v1/assets/next/display?')));assert.equal(f.created.length,2);assert.deepEqual(f.errors,[]);assertRestoreWorkDrained(f);
});


function captureControl(f,id='request-capture-single'){
 const template=find(f.instance.render(),'<en-button id="'+id+'"');assert(template,'The current request renders '+id);
 const disabled=template.strings.findIndex(part=>part.includes('?disabled='));assert(disabled>=0);
 return {disabled:template.values[disabled],click:template.values.find(value=>typeof value==='function')};
}
function captureTransport(f,gate){
 const commands=[],feedback=[],asset=previewProjection('captured').projection.value;
 f.editor.view.selected=['picture'];f.editor.beginFeedback=time=>feedback.push(time);
 f.editor.command=async(body,document)=>{commands.push({body:structuredClone(body),document:structuredClone(document)});if(gate){gate.entered.resolve();await gate.release.promise;}return [{type:'AssetRegistered',payload:{asset}}];};
 return {commands,feedback,asset};
}
for(const operation of ['Transform with Ideogram v4.5','Edit masked region with Ideogram v4.5'])test('rendered '+operation+' capture waits for child entry adoption',async t=>{
 const f=await previewController(t),capture=captureTransport(f),child=f.instance.requestEdits,dispose=child.dispose.bind(child),entered=previewDeferred(),adopt=previewDeferred();let pending;
 child.dispose=async()=>{await dispose();entered.resolve();await adopt.promise;};
 try{
  f.instance.operationChanged(operation);pending=f.start();await entered.promise;await flush();const entry=f.instance.entry(),saved=f.saved.length;
  for(const id of ['request-capture-single','request-capture-selected','request-capture-visible'])assert.equal(captureControl(f,id).disabled,true,'Capture is unavailable before the current entry is adopted');
  captureControl(f).click(event());await tick();await flush();assert.deepEqual(capture.commands,[]);assert.deepEqual(capture.feedback,[]);assert.equal(f.instance.entry(),entry);assert.equal(f.saved.length,saved);assert.equal(entry.draft.source,null);
  adopt.resolve();await pending;await flush();assert.equal(captureControl(f).disabled,false);
  captureControl(f).click(event());await f.entered;assert.deepEqual(capture.commands,[{body:{type:'PrepareRequestSource',scope:'single-layer',layerIds:['picture']},document:{id:'doc',revision:'1'}}]);f.finish();await Promise.all([...child.nativeWork]);await flush();
  const source=f.instance.entry().draft.source;assert.equal(source.assetId,'captured');assert.equal(source.scope,'single-layer');assert.deepEqual([source.width,source.height],[3,2]);assert.equal(source.documentRevision,'1');assert.deepEqual(source.capture,capture.asset.raster.manifest);assert.deepEqual(JSON.parse(f.saved.at(-1).text).draft.source,source);assert(child.sourceURL);assert.equal(f.created.length,1);assert.equal(capture.feedback.length,1);assert.deepEqual(f.editor.view.document,{id:'doc',revision:'1'});assert.deepEqual(f.errors,[]);
 }finally{adopt.resolve();f.finish();await Promise.allSettled([pending].filter(Boolean));await f.instance.dispose();await Promise.allSettled([...child.nativeWork]);}
});

for(const boundary of ['owner','revision','generation','dispose'])test('an adopted v4.5 source capture still refuses a late '+boundary+' result',async t=>{
 const f=await previewController(t,{gateAt:99}),gate={entered:previewDeferred(),release:previewDeferred()},capture=captureTransport(f,gate),child=f.instance.requestEdits;let closing;
 try{
  f.instance.operationChanged('Edit masked region with Ideogram v4.5');await f.start();assert.equal(captureControl(f).disabled,false);captureControl(f).click(event());await gate.entered.promise;assert.equal(capture.commands.length,1);
  if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};else if(boundary==='revision')f.editor.view.document={id:'doc',revision:'2'};else if(boundary==='generation')f.instance.mutateEntry('changed prompt',next=>{next.text='changed prompt';});else closing=f.track(f.instance.dispose());
  const saved=f.saved.length;gate.release.resolve();await Promise.allSettled([...child.nativeWork]);await closing;await flush();assert.equal(f.saved.length,saved);assert.equal(f.instance.entry()?.draft.source??null,null);assert.equal(f.renditions().length,0);assert.equal(f.created.length,0);assert.deepEqual(f.errors,[]);
 }finally{gate.release.resolve();await Promise.allSettled([closing,...child.nativeWork].filter(Boolean));await f.instance.dispose();}
});

function retainedOutputPage(f){
 const nav=find(f.template(),'<nav aria-label="Retained output pages">');assert(nav,'Actual retained-output navigation is rendered');
 const opening='<p role="status">';assert(nav.strings[0].includes(opening),'The page summary remains a status region');
 let text='',closed=false;
 for(let index=0;index<nav.strings.length;index++){
  const part=index===0?nav.strings[index].split(opening)[1]:nav.strings[index],end=part.indexOf('</p>');
  if(end!==-1){text+=part.slice(0,end);closed=true;break;}
  text+=part;assert(['string','number'].includes(typeof nav.values[index]),'Status text uses actual primitive bindings');text+=String(nav.values[index]);
 }
 assert(closed,'Rendered page status closes');
 const buttons=rendered({render:()=>nav}).buttons;assert.deepEqual(buttons.map(button=>button.name),['First retained outputs','Previous retained outputs','Next retained outputs']);const disabled=buttons.map(button=>button.disabledBinding);
 assert.equal(disabled.length,3,'First, Previous and Next remain rendered');assert(disabled.every(value=>typeof value==='boolean'));
 return {text:text.trim(),disabled};
}

async function retainedOutputPollingFixture(){
 const f=fixture();await f.initial();
 const queue=queueObservation('completed');queue.jobs[0].review.request.settings.count=3;queue.jobs[0].review.estimate.count=3;queue.jobs[0].attempts[0].estimate.count=3;
 const model=f.instance.navigation.controls.model(queue);f.instance.navigation.controls.replace('queue',model);f.instance.queue=model.value;
 const first=candidateObservation();first.requestedCount=3;first.actualCount=3;first.nextCursor='retained outputs / page 2';
 await publishCandidates(f,first);assert.equal(f.instance.pollTimer,null,'Fixture does not start autonomous queue polling');
 const observed=observeRequestAnnouncements(f),statusChanges=[retainedOutputPage(f).text],update=f.host.requestUpdate.bind(f.host);
 f.host.requestUpdate=function(){update();this.updateComplete=this.updateComplete.then(()=>{const nav=find(f.template(),'<nav aria-label="Retained output pages">');if(nav){const text=retainedOutputPage(f).text;if(statusChanges.at(-1)!==text)statusChanges.push(text);}});};
 return {...f,first,observed,statusChanges};
}

test('unchanged held candidate polls keep rendered page status quiet while preserving read ownership and busy controls',{timeout:5000},async()=>{
 const f=await retainedOutputPollingFixture(),stable=retainedOutputPage(f).text,announcement=requestAnnouncement(f),reads=[];
 assert.equal(stable,'Retained output page 1. 1 outputs on this page.');assert.deepEqual(retainedOutputPage(f).disabled,[true,true,false]);
 for(let cycle=0;cycle<3;cycle++){
  const held=pendingPage();f.editor.json=path=>{reads.push(path);return held.promise;};
  const pending=f.instance.inspectCandidates('job','attempt');void pending.catch(()=>{});
  try{
   await flush();assert.equal(reads.length,cycle+1);assert.equal(reads.at(-1),'/api/v1/jobs/job/candidates?attempt=attempt&after=');
   const owned=f.instance.inspectMemory().navigation;assert.equal(owned.candidateReads,1);assert.equal(owned.candidates.reads,1);assert(owned.candidates.pending>0);assert.equal(owned.candidates.models,1);
   assert.equal(retainedOutputPage(f).text,stable,'Automatic pending reads must not publish Loading requested page');assert.deepEqual(retainedOutputPage(f).disabled,[true,true,true]);
   await f.instance.inspectCandidates('job','attempt');await flush();assert.equal(reads.length,cycle+1,'A pending automatic read is not duplicated');
   held.resolve(structuredClone(f.first));await pending;await flush();
   assert.equal(retainedOutputPage(f).text,stable);assert.deepEqual(retainedOutputPage(f).disabled,[true,true,false]);
   const settled=f.instance.inspectMemory().navigation;assert.equal(settled.candidateReads,0);assert.equal(settled.candidates.reads,0);assert.equal(settled.candidates.pending,0);assert.equal(settled.candidates.models,1);
  }finally{held.resolve(structuredClone(f.first));await Promise.allSettled([pending]);await flush();}
 }
 assert.deepEqual(f.statusChanges,[stable],'Every actual render keeps the same retained-page status text');assert.equal(requestAnnouncement(f),announcement);assert.deepEqual(f.observed.changes,[announcement]);assert.deepEqual(f.observed.focus,[]);assert.equal(f.instance.pollTimer,null);
});

test('explicit candidate Next announces pending navigation, commits its page, and clears failed navigation without discarding the current page',{timeout:5000},async()=>{
 const f=await retainedOutputPollingFixture(),reads=[],loading='Loading requested page; current outputs remain available.',firstStatus=retainedOutputPage(f).text;
 const second=structuredClone(f.first);second.nextCursor='retained outputs / page 3';second.items[0].id='candidate-2';second.items[0].outputIndex=1;second.items[0].outputIdentity='output-2';
 const held=pendingPage();f.editor.json=path=>{reads.push(path);return held.promise;};
 const next=f.instance.navigateCandidatePage('job','attempt','next');assert(next&&typeof next.then==='function');void next.catch(()=>{});
 try{
  await flush();assert.equal(reads.at(-1),'/api/v1/jobs/job/candidates?attempt=attempt&after='+encodeURIComponent(f.first.nextCursor));
  assert.equal(retainedOutputPage(f).text,firstStatus+' '+loading);assert.deepEqual(retainedOutputPage(f).disabled,[true,true,true]);assert.equal(f.instance.candidateViews.get('attempt').items[0].id,'candidate');
  assert.equal(f.instance.inspectMemory().navigation.candidateReads,1);assert.equal(f.instance.inspectMemory().navigation.candidates.reads,1);
  await f.instance.inspectCandidates('job','attempt');await flush();assert.equal(reads.length,1,'Background polling cannot replace a pending explicit page action');assert.equal(retainedOutputPage(f).text,firstStatus+' '+loading);
  held.resolve(second);await next;await flush();
 }finally{held.resolve(second);await Promise.allSettled([next]);await flush();}
 const secondStatus='Retained output page 2. 1 outputs on this page.',retained=f.instance.candidateViews.get('attempt'),location=f.instance.navigation.candidatePage('attempt');
 assert.equal(retainedOutputPage(f).text,secondStatus);assert.deepEqual(retainedOutputPage(f).disabled,[false,false,false]);assert.equal(retained.items[0].id,'candidate-2');assert.deepEqual(location,{cursor:f.first.nextCursor,back:['']});assert.deepEqual(f.observed.focus,[]);
 const failed=pendingPage(),failure=Error('Retained output page unavailable');f.editor.json=async path=>{reads.push(path);await failed.promise;throw failure;};
 const rejected=f.instance.navigateCandidatePage('job','attempt','next');assert(rejected&&typeof rejected.then==='function');void rejected.catch(()=>{});
 try{
  await flush();assert.equal(reads.length,2);assert.equal(reads.at(-1),'/api/v1/jobs/job/candidates?attempt=attempt&after='+encodeURIComponent(second.nextCursor));
  assert.equal(retainedOutputPage(f).text,secondStatus+' '+loading);assert.deepEqual(retainedOutputPage(f).disabled,[true,true,true]);assert.strictEqual(f.instance.candidateViews.get('attempt'),retained);
  failed.resolve();await assert.rejects(rejected,/Retained output page unavailable/);await flush();
  assert.equal(retainedOutputPage(f).text,secondStatus);assert.deepEqual(retainedOutputPage(f).disabled,[false,false,false]);assert.strictEqual(f.instance.candidateViews.get('attempt'),retained);assert.strictEqual(f.instance.navigation.candidatePage('attempt'),location);
  const settled=f.instance.inspectMemory().navigation;assert.equal(settled.candidateReads,0);assert.equal(settled.candidates.reads,0);assert.equal(settled.candidates.pending,0);assert.equal(settled.candidates.models,1);
  assert.deepEqual(f.statusChanges,[firstStatus,firstStatus+' '+loading,secondStatus,secondStatus+' '+loading,secondStatus]);assert.deepEqual(f.observed.focus,[]);assert.equal(f.instance.pollTimer,null);
 }finally{failed.resolve();await Promise.allSettled([rejected]);await flush();}
});

test('current-owner prepare and acceptance rejection settle review progress while retaining genuine issues and focus',{timeout:5000},async()=>{
 for(const kind of ['prepare','accept']){
  const f=fixture();await f.initial();f.prompt()(f.promptEvent('Retained review input'));await flush();
  f.editor.requestReview=async()=>({review:frozenReview()});if(kind==='accept')await act(f,'prepare-request');
  const observed=observeRequestAnnouncements(f),held=previewDeferred(),calls=[],failure=Error('STALE_REVISION: Review the current document; your draft is retained.');
  f.editor.requestReview=body=>{calls.push(body);return held.promise;};
  try{
   await act(f,kind==='prepare'?'prepare-request':'accept-request');
   assert.equal(calls.length,1);assert.equal(calls[0].type,kind==='prepare'?'PrepareRequestReview':'AcceptRequestReview');
   assert.equal(requestAnnouncement(f),kind==='prepare'?'Saving request draft for review…':'Saving request review acceptance…');
   assert.equal(pageControl(f,'prepare-request').disabled,true);assert(f.instance.inspectMemory().navigation.controls.pending>0);
   held.reject(failure);await flush();
   assert.equal(requestAnnouncement(f),'Request review could not be confirmed. Check the current draft and review before continuing.');
   assert.equal(pageControl(f,'prepare-request').disabled,false);assert.equal(f.instance.busy,false);assert.equal(f.instance.accepted,false);
   assert.deepEqual(f.instance.issues,[{field:'review',code:'REVIEW',message:failure.message}]);assert(find(f.template(),'id="request-errors"'));
   assert.deepEqual(observed.focus,['#request-errors']);assert.equal(observed.changes.length,3,'Initial, pending and one settled notice');
   assert.equal(f.instance.entry().text,'Retained review input');assertRestoreWorkDrained(f);
  }finally{held.resolve({review:frozenReview()});await Promise.allSettled([...f.instance.entryTasks]);await flush();await f.instance.dispose();}
 }
});

test('review progress settles revision and native prompt supersession without publishing a late review or error',{timeout:5000},async()=>{
 for(const kind of ['prepare','accept'])for(const boundary of ['revision','generation'])for(const outcome of ['accepted','rejected']){
  const f=fixture();await f.initial();f.prompt()(f.promptEvent('Original review input'));await flush();
  f.editor.requestReview=async()=>({review:frozenReview()});if(kind==='accept')await act(f,'prepare-request');
  const observed=observeRequestAnnouncements(f),held=previewDeferred(),calls=[];
  f.editor.requestReview=body=>{calls.push(body);return held.promise;};
  try{
   await act(f,kind==='prepare'?'prepare-request':'accept-request');assert.equal(calls.length,1);assert.match(requestAnnouncement(f),/^Saving request/);
   if(boundary==='revision'){f.editor.view.document={...f.editor.view.document,revision:'2'};f.host.requestUpdate();await flush();}
   else{f.prompt()(f.promptEvent('New current input'));await flush();}
   const retainedReview=f.instance.review;
   if(outcome==='rejected')held.reject(Error('Late review rejection'));
   else held.resolve(kind==='prepare'?{review:{...frozenReview(),id:'late-review'}}:{acceptedReview:'review',requestId:'late-acceptance'});
   await flush();
   assert.equal(requestAnnouncement(f),'Request review action settled after the draft or document changed. Review the current draft before continuing.');
   assert.equal(pageControl(f,'prepare-request').disabled,false);assert.equal(f.instance.busy,false);assert.equal(f.instance.accepted,false);
   assert.strictEqual(f.instance.review,retainedReview,'An obsolete result does not replace the current review');assert.deepEqual(f.instance.issues,[]);
   assert.deepEqual(observed.focus,[]);assert.equal(observed.changes.length,3);assertRestoreWorkDrained(f);
   assert.equal(f.instance.entry().text,boundary==='generation'?'New current input':'Original review input');
  }finally{held.resolve({review:frozenReview()});await Promise.allSettled([...f.instance.entryTasks]);await flush();await f.instance.dispose();}
 }
});

test('old review progress preserves newer notices and ownership while same-key retries can announce again',{timeout:5000},async()=>{
 for(const successor of ['provider','review']){
  const f=fixture();await f.initial();f.prompt()(f.promptEvent('First request'));await flush();
  const observed=observeRequestAnnouncements(f),old=previewDeferred(),next=previewDeferred(),calls=[];
  f.editor.requestReview=body=>{calls.push(body);assert(calls.length<=2);return calls.length===1?old.promise:next.promise;};
  try{
   await act(f,'prepare-request');assert.equal(calls.length,1);const pending=requestAnnouncement(f);assert.equal(pending,'Saving request draft for review…');
   f.prompt()(f.promptEvent('Second request'));await flush();
   if(successor==='provider')await publishCandidates(f,candidateObservation());
   else{await act(f,'prepare-request');assert.equal(calls.length,2);assert.equal(requestAnnouncement(f),pending,'The two distinct live actions deliberately use identical pending text');}
   const newerNotice=requestAnnouncement(f),changes=observed.changes.length;
   old.resolve({review:{...frozenReview(),id:'obsolete-review'}});await flush();
   assert.equal(requestAnnouncement(f),newerNotice);assert.equal(observed.changes.length,changes);assert.equal(f.instance.review,null);assert.deepEqual(f.instance.issues,[]);assert.deepEqual(observed.focus,[]);
   if(successor==='provider'){
    assert.match(newerNotice,/completed|prepared/i);assert.equal(pageControl(f,'prepare-request').disabled,false);assertRestoreWorkDrained(f);
   }else{
    assert.equal(f.instance.busy,true);assert.equal(pageControl(f,'prepare-request').disabled,true);assert(f.instance.inspectMemory().navigation.controls.pending>0,'The newer action remains owned after the old finally');
    next.resolve({review:{...frozenReview(),id:'successor-review'}});await flush();
    assert.equal(f.instance.review.id,'successor-review');assert.equal(requestAnnouncement(f),'Exact request saved and ready for review.');assert.equal(pageControl(f,'prepare-request').disabled,false);assert.deepEqual(observed.focus,['#request-review']);assertRestoreWorkDrained(f);
   }
  }finally{old.resolve({review:frozenReview()});next.resolve({review:frozenReview()});await Promise.allSettled([...f.instance.entryTasks]);await flush();await f.instance.dispose();}
 }
 for(const kind of ['prepare','accept']){
  const f=fixture();await f.initial();f.prompt()(f.promptEvent('Unchanged retry input'));await flush();
  f.editor.requestReview=async()=>({review:frozenReview()});if(kind==='accept')await act(f,'prepare-request');
  const observed=observeRequestAnnouncements(f),first=previewDeferred(),retry=previewDeferred(),calls=[],generation=f.instance.entry().generation;
  f.editor.requestReview=body=>{calls.push(body);assert(calls.length<=2);return calls.length===1?first.promise:retry.promise;};
  try{
   await act(f,kind==='prepare'?'prepare-request':'accept-request');assert.equal(calls.length,1);const pending=requestAnnouncement(f);
   await publishCandidates(f,candidateObservation());const provider=requestAnnouncement(f);assert.match(provider,/completed|prepared/i);
   first.reject(Error('Review delivery refused'));await flush();
   assert.equal(requestAnnouncement(f),provider,'Current-owner failure must preserve the newer provider notice');assert.equal(f.instance.busy,false);assert.equal(f.instance.entry().generation,generation);
   assert.deepEqual(observed.focus,['#request-errors']);assert.equal(f.instance.issues[0].message,'Review delivery refused');assertRestoreWorkDrained(f);
   await act(f,kind==='prepare'?'prepare-request':'accept-request');assert.equal(calls.length,2);assert.equal(f.instance.entry().generation,generation);
   assert.equal(requestAnnouncement(f),pending,'A retry of the same draft generation or immutable review must publish Saving again');assert.equal(f.instance.busy,true);
   assert.equal(observed.changes.filter(text=>text===pending).length,2);
   retry.resolve(kind==='prepare'?{review:{...frozenReview(),id:'retried-review'}}:{acceptedReview:'review',requestId:'retried-acceptance'});await flush();
   assert.equal(f.instance.busy,false);assert.match(requestAnnouncement(f),kind==='prepare'?/saved and ready for review/:/accepted locally/);assertRestoreWorkDrained(f);
  }finally{first.resolve({review:frozenReview()});retry.resolve({review:frozenReview()});await Promise.allSettled([...f.instance.entryTasks]);await flush();await f.instance.dispose();}
 }
});

test('owner replacement and document release suppress obsolete review settlement and drain its real action ownership',{timeout:5000},async()=>{
 const {allocationLedger}=await import(allocationsURL);
 for(const kind of ['prepare','accept'])for(const boundary of ['owner','session','document','identity','connection','releaseDocument','dispose']){
  const baseline=allocationLedger.snapshot().byKind.control,f=fixture();
  // Only the fixture UI root outlives controller disposal; constructor-owned
  // request-edit diagnostics, selection and index must drain with the controller.
  const retainedUI={...baseline,cpuBytes:baseline.cpuBytes+modelPayloadBytes(f.editor.ui),handles:baseline.handles+1};
  await f.initial();f.prompt()(f.promptEvent('Previous owner input'));await flush();
  f.editor.requestReview=async()=>({review:frozenReview()});if(kind==='accept')await act(f,'prepare-request');
  const observed=observeRequestAnnouncements(f),held=previewDeferred(),calls=[];let closing,closed=false;
  f.editor.requestReview=body=>{calls.push(body);return held.promise;};
  try{
   await act(f,kind==='prepare'?'prepare-request':'accept-request');assert.equal(calls.length,1);assert.match(requestAnnouncement(f),/^Saving request/);
   if(boundary==='releaseDocument'||boundary==='dispose'){
    closing=f.instance[boundary]().then(()=>{closed=true;});await flush();assert.equal(closed,false,'Release still awaits the real held action');
    assert.equal(f.instance.announcement,'');assert.equal(find(f.template(),'id="request-announcements"'),undefined);
   }else{
    if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};else if(boundary==='session')f.editor.sessionId='replacement-session';else if(boundary==='document')f.editor.view.document={id:'replacement-document',revision:'1'};else if(boundary==='identity')f.identity('replacement-identity');else f.editor.session={...f.editor.session};
    f.editor.json=async()=>({items:[]});await f.instance.sync();f.host.requestUpdate();await flush();assert.equal(requestAnnouncement(f),'');
    await act(f,'request-read-status');assert.match(requestAnnouncement(f),/^Current request status\./);
   }
   const newerNotice=f.instance.announcement,changes=observed.changes.length,review=f.instance.review;
   held.reject(Error('Retired owner rejection'));await flush();await closing;await flush();
   assert.equal(f.instance.announcement,newerNotice);assert.equal(observed.changes.length,changes);assert.strictEqual(f.instance.review,review);assert.deepEqual(f.instance.issues,[]);assert.deepEqual(observed.focus,[]);assertRestoreWorkDrained(f);
   if(closing){assert.equal(closed,true);assert.equal(f.instance.inspectMemory().entries,0);assert.equal(find(f.template(),'id="request-announcements"'),undefined);}
  }finally{held.resolve({review:frozenReview()});await Promise.allSettled([...f.instance.entryTasks]);await closing;await f.instance.dispose();await flush();}
  const unpinUI=f.editor.pinUI();unpinUI();
  assert.deepEqual(allocationLedger.snapshot().byKind.control,retainedUI,'All controller control reservations, including review progress, drain back to the separately retained fixture UI root');
 }
});

test('queue command protects its receipt refresh from an already scheduled poll and resumes polling afterward',async t=>{
 const f=await paginationFixture(t),receipt=pendingPage(),refresh=pendingPage(),body={type:'RecoverJob',jobId:'newest',attemptId:'attempt-newest',expectedVersion:'1'};
 const observed=observeRequestAnnouncements(f),reads=f.reads.length;let settled=false,error;
 f.editor.command=()=>receipt.promise;f.setReader(()=>refresh.promise);
 f.instance.action(event(),async()=>{try{await f.instance.queueCommand(body);}catch(value){error=value;throw value;}finally{settled=true;}});await f.advance(0);
 try{
  assert.equal(f.instance.queueBusy,true);assert.equal(f.reads.length,reads);assert.notEqual(f.instance.pollTimer,null,'A real earlier queue refresh scheduled the timer');
  receipt.resolve([{type:'QueueStateChanged',payload:{}}]);await flush();assert.equal(f.reads.length,reads+1,'The saved command starts its own original refresh');
  await f.advance(150);assert.equal(f.reads.length,reads+1,'The prior timer cannot invalidate the held command refresh');assert.equal(f.instance.pollTimer,null);assert.equal(settled,false);
  f.instance.poll();await f.advance(300);assert.equal(f.reads.length,reads+1,'Busy commands cannot schedule another background read');
  refresh.resolve(f.pages.get(''));await flush();assert.equal(settled,true);assert.equal(error,undefined);assert.equal(f.instance.queueBusy,false);assert.deepEqual(f.instance.issues,[]);assert.deepEqual(observed.focus,[]);
  assert.match(f.instance.message,/^Queue change saved locally\./);assert(!observed.changes.some(value=>value.includes('could not be confirmed')));
  f.setReader(null);const resumed=f.reads.length;assert.notEqual(f.instance.pollTimer,null,'Settled command restores background observation');await f.advance(150);assert.equal(f.reads.length,resumed+1);assert.deepEqual(observed.focus,[]);
 }finally{receipt.resolve([]);refresh.resolve(f.pages.get(''));await flush();await Promise.allSettled([...f.instance.entryTasks]);await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('a poll already reading before a queue command cannot inspect candidates while that command owns the queue',async t=>{
 const f=await paginationFixture(t),old=pendingPage(),receipt=pendingPage(),body={type:'RecoverJob',jobId:'newest',attemptId:'attempt-newest',expectedVersion:'1'};
 const view=structuredClone(f.pages.get(''));view.jobs[0].attempts[0].requestId='existing-provider-request';let candidateReads=0;
 const json=f.editor.json.bind(f.editor);f.editor.json=path=>path.includes('/candidates')?(candidateReads++,candidateObservation()):json(path);f.setReader(()=>old.promise);
 await f.advance(150);assert.equal(f.instance.polling,true);f.editor.command=()=>receipt.promise;const command=f.instance.queueCommand(body);
 try{
  old.resolve(view);await flush();assert.equal(f.instance.queueBusy,true);assert.equal(f.instance.polling,false);assert.equal(candidateReads,0,'An older background continuation yields to the explicit action');assert.equal(f.instance.pollTimer,null);
  f.setReader(null);receipt.resolve([{type:'QueueStateChanged',payload:{}}]);await command;await flush();assert.equal(f.instance.queueBusy,false);assert.notEqual(f.instance.pollTimer,null);assert.deepEqual(f.focus,[]);
 }finally{old.resolve(view);receipt.resolve([]);await command;await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('queue command keeps genuine refresh rejection and validation focus while restoring later polling',async t=>{
 const f=await paginationFixture(t),observed=observeRequestAnnouncements(f),failure=Error('Exact queue response failure'),body={type:'RecoverJob',jobId:'newest',attemptId:'attempt-newest',expectedVersion:'1'};let caught;
 f.setReader(()=>{throw failure;});f.instance.action(event(),async()=>{try{await f.instance.queueCommand(body);}catch(error){caught=error;throw error;}});await f.advance(0);await flush();
 try{
  assert.strictEqual(caught,failure,'No broad abort or error suppression');assert.equal(f.instance.queueBusy,false);assert.match(f.instance.message,/^Queue change could not be confirmed\./);assert.deepEqual(f.instance.issues,[{field:'review',code:'REVIEW',message:failure.message}]);assert.deepEqual(observed.focus,['#request-errors']);
  f.setReader(null);const reads=f.reads.length;await f.advance(150);assert.equal(f.reads.length,reads+1);assert.deepEqual(observed.focus,['#request-errors'],'Later background observation adds no focus action');
 }finally{await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('retired queue command cannot restart polling or disturb a successor action',async t=>{
 const f=await paginationFixture(t),receipt=pendingPage(),body={type:'RecoverJob',jobId:'newest',attemptId:'attempt-newest',expectedVersion:'1'};f.editor.command=()=>receipt.promise;
 const command=f.instance.queueCommand(body);await flush();await f.advance(150);assert.equal(f.instance.pollTimer,null);
 const replacement={};f.instance.queueAction=replacement;f.editor.draftOwner={drafts:new Map()};const reads=f.reads.length;
 try{receipt.resolve([{type:'QueueStateChanged',payload:{}}]);await command;await flush();assert.strictEqual(f.instance.queueAction,replacement);assert.equal(f.instance.queueBusy,true);assert.equal(f.instance.pollTimer,null);await f.advance(300);assert.equal(f.reads.length,reads);assert.deepEqual(f.focus,[]);}
 finally{receipt.resolve([]);await command;await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});


// Exercise the actual rendered request-region callbacks with the public composed
// path shape observed by the E3 Firefox reveal diagnostic. This fixture does not
// simulate browser composition dispatch or the actual comparison rendering.
const e3CompositionEvent=(rootClass='candidate-comparison')=>({composedPath:()=>[
 {id:'control'}, {id:'candidate-comparison-fixture-lettering-alone-off-reveal'},
 {classList:{contains:name=>name===rootClass}},
 {classList:{contains:name=>name==='typed-request'}},
]});
const e3CompositionCallbacks=f=>find(f.template(),'<section aria-label="Typed request draft"').values.filter(value=>typeof value==='function').slice(0,2);

test('comparison composition preserves the saved request and its existing review ownership',async()=>{
 const f=fixture();await f.initial();f.prompt()(f.promptEvent('Retained exact request'));await flush();f.button()(event());await tick();await flush();
 assert.equal(f.reviews.length,1);const review=f.instance.review,entry=f.instance.entry(),generation=entry.generation,saved=f.saved.length,owns=f.instance.owns();assert(review);assert(owns());
 const [start,end]=e3CompositionCallbacks(f),comparison=e3CompositionEvent();
 start(comparison);await flush();assert.equal(f.instance.composing,false);assert(owns(),'View-control composition must not invalidate a saved request owner');
 end(comparison);await flush();assert.equal(f.instance.composing,false);assert(owns());assert.equal(f.instance.entry(),entry);assert.equal(f.instance.entry().generation,generation);assert.equal(f.saved.length,saved);assert.equal(f.instance.review,review);assert.equal(f.reviews.length,1);
});

test('genuine request composition still invalidates its prior owner and saves the settled composing state',async()=>{
 const f=fixture();await f.initial();f.prompt()(f.promptEvent('Original request'));await flush();const owns=f.instance.owns(),saved=f.saved.length,[start,end]=e3CompositionCallbacks(f),prompt={composedPath:()=>[{id:'prompt'},{classList:{contains:name=>name==='typed-request'}}]};
 start(prompt);await flush();assert.equal(f.instance.composing,true);assert.equal(owns(),false);assert(f.saved.length>saved);assert.equal(f.saved.at(-1).composing,true);
 end(prompt);await flush();assert.equal(f.instance.composing,false);assert.equal(f.saved.at(-1).composing,false);
});

test('comparison composition end cannot release a genuine spend-cap composition command guard',async()=>{
 const f=await capController(),host={value:'',isConnected:true},[start,end]=e3CompositionCallbacks(f),cap={composedPath:()=>[{id:'request-cap'},{classList:{contains:name=>name==='typed-request'}}]};
 start(cap);await flush();const [input,change]=f.field();input(capEvent(host,'1',true));host.value='1';change(capEvent(host));input(capEvent(host,'1',false));await flush();
 const saved=f.saved.length,owns=f.instance.owns();end(e3CompositionEvent());await flush();assert.equal(f.instance.composing,true);assert.equal(f.saved.length,saved);assert(owns());await submitCap(f);assert.deepEqual(f.commands,[]);
 end(cap);await flush();assert.equal(f.instance.composing,false);await submitCap(f);assert.deepEqual(f.commands,[{document:null,body:{type:'SetSpendGuard',spendSessionId:'spend-session',expectedConfigVersion:'4',cap:1}}]);assert.equal(f.saved.at(-1).composing,false);
});

test('a similarly named class cannot suppress genuine request composition ownership',async()=>{
 const f=fixture();await f.initial();const [start,end]=e3CompositionCallbacks(f),owns=f.instance.owns(),unrelated=e3CompositionEvent('candidate-comparison-pair');
 start(unrelated);await flush();assert.equal(f.instance.composing,true);assert.equal(owns(),false);end(unrelated);await flush();assert.equal(f.instance.composing,false);assert.equal(f.saved.at(-1).composing,false);
});

test('retired rendered request composition callbacks cannot mutate a successor identity',async()=>{
 const f=fixture();await f.initial();const [start,end]=e3CompositionCallbacks(f),saved=f.saved.length;f.identity('replacement-owner');
 start({composedPath:()=>[{id:'prompt'}]});end({composedPath:()=>[{id:'prompt'}]});await flush();assert.equal(f.saved.length,saved);assert.equal(f.instance.composing,false);
});

// E4: local deletion coordinates only request observation; server NOT_FOUND
// and actual owned-read cleanup retain their existing authority.
test('confirmed deletion pause keeps retained request state and resumes one scheduled poll',async t=>{
 const f=await paginationFixture(t),queue=f.instance.queue,drafts=[...f.editor.draftOwner.drafts],reads=f.reads.length;
 const lease=f.instance.pauseDocumentObservation('doc');await lease.drain;
 try{
  await f.advance(1000);assert.equal(f.reads.length,reads);assert.equal(f.instance.pollTimer,null);
  assert.strictEqual(f.instance.queue,queue);assert.deepEqual([...f.editor.draftOwner.drafts],drafts);assert.equal(f.instance.requestReleasing,false);
  lease.release();lease.release();await f.advance(150);assert.equal(f.reads.length,reads+1,'An idempotent release restores one poll');
 }finally{lease.release();await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});
test('deletion drains the real held queue read before its candidate continuation can start',async t=>{
 const f=await paginationFixture(t),held=pendingPage(),view=structuredClone(f.pages.get(''));view.jobs[0].attempts[0].requestId='provider-known';let candidates=0,drained=false;
 const json=f.editor.json.bind(f.editor);f.editor.json=(path,...args)=>path.includes('/candidates')?(candidates++,candidateObservation()):json(path,...args);f.setReader(()=>held.promise);
 await f.advance(150);assert.equal(f.instance.polling,true);const lease=f.instance.pauseDocumentObservation('doc');void lease.drain.then(()=>{drained=true;});
 try{
  await f.advance(450);assert.equal(drained,false);assert.equal(candidates,0);
  held.resolve(view);await lease.drain;await flush();assert.equal(drained,true);assert.equal(candidates,0);assert.equal(f.instance.observationTasks.size,0);assert.equal(f.instance.polling,false);assert.equal(f.instance.pollTimer,null);
  assert.equal(f.instance.queue.jobs[0].attempts[0].requestId,null,'The fenced read did not replace the retained queue');
  f.setReader(null);lease.release();await f.advance(150);assert.equal(candidates,0);
 }finally{held.resolve(view);lease.release();await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});
test('deletion drains superseded and current actual candidate readers without late publication',async t=>{
 const f=fixture();await f.initial();t.mock.timers.enable({apis:['setTimeout']});const old=pendingPage(),latest=pendingPage(),observed=observeRequestAnnouncements(f);let calls=0;
 f.editor.json=()=>++calls===1?old.promise:latest.promise;
 const first=f.instance.inspectCandidates('job','attempt','',{cursor:'',back:[]});void first.catch(()=>{});await flush();
 const second=f.instance.inspectCandidates('job','attempt','next',{cursor:'next',back:['']});void second.catch(()=>{});await flush();assert.equal(calls,2);assert.equal(f.instance.inspectMemory().navigation.candidateReads,2);
 const lease=f.instance.pauseDocumentObservation('doc');let drained=false;void lease.drain.then(()=>{drained=true;});
 try{
  latest.resolve(candidateObservation());await second;await flush();assert.equal(drained,false,'The superseded older read is still owned');
  old.resolve(candidateObservation());await first;await lease.drain;await flush();assert.equal(drained,true);
  assert.equal(f.instance.candidateViews.size,0);assert.equal(f.instance.inspectMemory().navigation.candidateReads,0);assert.equal(f.instance.observationTasks.size,0);assert.deepEqual(observed.focus,[]);assert.deepEqual(f.instance.issues,[]);
 }finally{old.resolve(candidateObservation());latest.resolve(candidateObservation());lease.release();await Promise.allSettled([first,second]);await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});
test('deletion pause fences captured and fresh result controls plus history and exact-prompt paths',async t=>{
 const f=fixture();await f.initial();t.mock.timers.enable({apis:['setTimeout']});await publishCandidates(f,candidateObservation());
 const current=f.instance.candidateViews.get('attempt'),old=publicButton(f.instance.results('job','attempt'),'Inspect retained results').click,draft=f.instance.entry();assert.equal(typeof old,'function');let reads=0;f.editor.json=async()=>{reads++;throw Error('No observation is admitted during deletion');};
 const lease=f.instance.pauseDocumentObservation('doc');await lease.drain;
 try{
  old(event());publicButton(f.instance.results('job','attempt'),'Inspect retained results').click(event());t.mock.timers.tick(0);await flush();
  await Promise.all([f.instance.refreshQueue(),f.instance.inspectHistory(),f.instance.inspectCandidates('job','attempt','next',{cursor:'next',back:['']}),f.instance.readPrompt('job','attempt','requested')]);
  assert.equal(reads,0);assert.strictEqual(f.instance.candidateViews.get('attempt'),current);assert.strictEqual(f.instance.entry(),draft);assert.equal(f.instance.requestReleasing,false);assert.deepEqual(f.instance.issues,[]);
 }finally{lease.release();await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});
test('accepted deletion remains fenced while the old document projection is still visible',async t=>{
 const f=await paginationFixture(t),reads=f.reads.length,lease=f.instance.pauseDocumentObservation('doc');await lease.drain;lease.accepted();lease.release();
 try{
  assert.equal(f.editor.view.document.id,'doc');await f.advance(600);await f.instance.inspectHistory();assert.equal(f.reads.length,reads);assert.equal(f.instance.pollTimer,null);assert.equal(f.instance.observationBarrier.accepted,true);
  f.editor.documentEpoch++;f.editor.view.document={id:'next-document',revision:'1'};f.editor.draftOwner={drafts:new Map()};await f.instance.sync();await flush();
  await f.instance.refreshQueue();assert.equal(f.reads.length,reads+1,'A genuinely new document owner can observe again');
 }finally{await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});
for(const boundary of ['document','session','identity','connection','draft-owner','document-epoch'])test('old deletion lease cannot release the successor observation barrier after '+boundary,async t=>{
 const f=await paginationFixture(t),old=f.instance.pauseDocumentObservation('doc');await old.drain;
 if(boundary==='document')f.editor.view.document={id:'next-document',revision:'1'};
 if(boundary==='session')f.editor.sessionId='next-session';
 if(boundary==='identity')f.identity('next-identity');
 if(boundary==='connection')f.editor.session={...f.editor.session};
 if(boundary==='draft-owner')f.editor.draftOwner={drafts:new Map()};
 if(boundary==='document-epoch')f.editor.documentEpoch++;
 // The real shell syncs RequestEditing on public owner changes; this fixture's
 // host only renders. A document/draft-owner replacement must restore its own
 // entry and queue before a successor deletion lease can later resume reads.
 if(boundary==='document'||boundary==='draft-owner')assert.equal(f.instance.owns(false)(),false,'The retired entry cannot authorize a successor read');
 await f.instance.sync();await flush();
 assert.strictEqual(f.instance.owner,f.editor.draftOwner);assert.equal(f.instance.documentId,f.editor.view.document.id);assert.equal(f.instance.owns(false)(),true,'The real sync restored current request authority');
 await f.instance.refreshQueue();await flush();assert(f.instance.queue,'The successor queue is actually hydrated');assert.equal(f.instance.queue.jobs[0].id,'newest');assert.equal(pageNumber(f),1);
 const successor=f.instance.pauseDocumentObservation(f.editor.view.document.id);await successor.drain;const token=f.instance.observationBarrier,reads=f.reads.length;
 try{old.accepted();old.release();await f.advance(300);assert.strictEqual(f.instance.observationBarrier,token);assert.equal(f.reads.length,reads);successor.release();await f.advance(150);assert.equal(f.reads.length,reads+1);}
 finally{old.release();successor.release();await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});
test('local deletion fencing never turns a genuine candidate NOT_FOUND into an empty success',async()=>{
 const f=fixture();await f.initial();let reject;const pending=new Promise((_,no)=>{reject=no;}),failure=Error('NOT_FOUND: another client deleted the document');f.editor.json=()=>pending;
 const read=f.instance.inspectCandidates('job','attempt');void read.catch(()=>{});await flush();const lease=f.instance.pauseDocumentObservation('doc');
 try{reject(failure);await assert.rejects(read,error=>error===failure);await lease.drain;assert.equal(f.instance.candidateViews.size,0);assert.equal(f.instance.observationTasks.size,0);}
 finally{reject(failure);lease.release();await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('deletion fence covers reads queued before their owned transport callback starts',async()=>{
 const f=fixture();await f.initial();let requests=0;f.editor.json=async()=>{requests++;return candidateObservation();};
 const read=f.instance.inspectCandidates('job','attempt'),lease=f.instance.pauseDocumentObservation('doc');
 try{await Promise.all([read,lease.drain]);assert.equal(requests,0);assert.equal(f.instance.observationTasks.size,0);assert.equal(f.instance.candidateViews.size,0);}
 finally{lease.release();await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});


for(const boundary of ['accepted','owner','veto'])test(`shared rendered operation-default action preserves ${boundary} admission`,async()=>{
 const f=fixture();await f.initial();f.instance.mutateEntry(undefined,next=>{next.draft.fields.strength='0.4';});await flush();
 const button=publicButton(f.template(),'Use operation strength default'),before=f.saved.length,click=event();assert.equal(button.disabled,false);
 button.click(click);if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};if(boundary==='veto')click.defaultPrevented=true;await tick();await flush();
 if(boundary==='accepted'){assert(f.saved.length>before,'The actual guarded action saves its draft');assert.equal(lastDraft(f).fields.strength,'0.8');}
 else{assert.equal(f.saved.length,before,'A captured shared button cannot bypass changed authority or late veto');assert.equal(f.instance.entry().draft.fields.strength,'0.4');}
});


// Fixture retirement uses the same real request owner release that shell
// disconnection invokes. These controls do not implement a browser DOM fixture.
test('document release synchronously retires a scheduled queue poll without saving a new draft',{timeout:5000},async t=>{
 const f=await paginationFixture(t),beforeReads=f.reads.length,saved=structuredClone(f.saved),drafts=structuredClone([...f.editor.draftOwner.drafts]),ui=structuredClone(f.editor.ui);
 let release;
 try{
  assert.notEqual(f.instance.pollTimer,null,'The real initial queue refresh scheduled its next poll');
  await f.advance(149);assert.equal(f.reads.length,beforeReads);
  release=f.instance.releaseDocument();assert.strictEqual(f.instance.releaseDocument(),release,'Repeated release shares the actual drain');
  assert.equal(f.instance.pollTimer,null,'The scheduled timer is removed synchronously');assert.equal(f.instance.polling,false);assert.equal(f.instance.queue,null);
  await release;await f.advance(1000);
  assert.equal(f.reads.length,beforeReads,'No queue read starts after retirement');assert.equal(f.instance.observationTasks.size,0);
  assert.deepEqual(f.saved,saved);assert.deepEqual([...f.editor.draftOwner.drafts],drafts);assert.deepEqual(f.editor.ui,ui);assert.deepEqual(f.commands,[]);
 }finally{await release;await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('document release retains the original held queue completion and forbids its candidate continuation',{timeout:5000},async t=>{
 const f=await paginationFixture(t),held=pendingPage(),view=structuredClone(f.pages.get(''));view.jobs[0].attempts[0].requestId='provider-known';
 let candidates=0,released=false,observed=false,release,settlement;
 const json=f.editor.json.bind(f.editor);f.editor.json=(path,...args)=>path.includes('/candidates')?(candidates++,candidateObservation()):json(path,...args);f.setReader(()=>held.promise);
 try{
  const before=f.reads.length;await f.advance(150);assert.equal(f.reads.length,before+1);assert.equal(f.instance.polling,true);
  const originals=[...f.instance.observationTasks.keys()];assert(originals.length>0,'The original poll/read tasks remain owned');
  settlement=Promise.allSettled(originals).then(results=>{observed=true;return results;});
  release=f.instance.releaseDocument();void release.then(()=>{released=true;},()=>{});
  assert.equal(f.instance.pollTimer,null);assert.equal(f.instance.polling,false);assert.equal(f.instance.queue,null);
  await f.advance(450);assert.equal(released,false,'Release cannot forget the held original transport');assert.equal(observed,false);assert.equal(candidates,0);assert.equal(f.reads.length,before+1);
  held.resolve(view);await release;const results=await settlement;await flush();
  assert.equal(released,true);assert.equal(observed,true);assert(results.every(result=>result.status==='rejected'&&result.reason?.name==='AbortError'),'Original stale read outcomes remain observable');
  assert.equal(f.instance.observationTasks.size,0);assert.equal(f.instance.queue,null);assert.equal(candidates,0);assert.equal(f.instance.candidateViews.size,0);
  await f.advance(1000);assert.equal(f.reads.length,before+1);assert.equal(f.instance.pollTimer,null);assert.equal(f.instance.polling,false);
 }finally{held.resolve(view);await Promise.allSettled([release,settlement].filter(Boolean));await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('document release waits for the real owned queue body cancellation before reporting its drain',{timeout:5000},async t=>{
 const f=await paginationFixture(t),entered=pendingPage(),cancelGate=pendingPage();let calls=0,cancels=0,signal,release,released=false,readSettled=false,originalSettlement;
 const body=new ReadableStream({pull(){entered.resolve();},cancel(){cancels++;return cancelGate.promise;}},{highWaterMark:0});
 // Replace only the synthetic editor transport boundary; the request owner,
 // UIModelOwner, owned JSON parser and native reader/cancellation all stay real.
 f.editor.ownedJSON=(path,owner,init,current,maxBytes,kind)=>{
  assert.equal(path,'/api/v1/queue');calls++;signal=init.signal;
  const original=readOwnedJSON(async()=>new Response(body,{headers:{'content-length':'2'}}),path,{owner,init,owns:current,maxBytes,kind});
  originalSettlement=Promise.allSettled([original]).then(results=>{readSettled=true;return results;});return original;
 };
 try{
  await f.advance(150);await entered.promise;assert.equal(calls,1);assert.equal(body.locked,true);assert.equal(signal.aborted,false);assert.equal(f.instance.inspectMemory().navigation.controls.reads,1);
  release=f.instance.releaseDocument();void release.then(()=>{released=true;},()=>{});assert.equal(signal.aborted,true,'Actual owner retirement aborts its own read');
  await f.advance(1000);assert.equal(cancels,1);assert.equal(readSettled,false);assert.equal(released,false,'A requested native cancel is not a completed drain');assert.equal(body.locked,true);assert.equal(calls,1);
  assert.equal(f.instance.inspectMemory().navigation.controls.reads,1,'The original read remains counted while native cancellation is pending');assert.equal(f.instance.pollTimer,null);
  cancelGate.resolve();await release;const [result]=await originalSettlement;await flush();
  assert.equal(result.status,'rejected');assert.match(result.reason.message,/PROMPT_READ_STALE/);assert.equal(readSettled,true);assert.equal(released,true);assert.equal(cancels,1);assert.equal(body.locked,false);
  assert.deepEqual(f.instance.inspectMemory().navigation.controls,{models:0,reads:0,pending:0,cleanupFailures:0});assert.equal(f.instance.observationTasks.size,0);assert.equal(f.instance.queue,null);assert.equal(f.instance.candidateViews.size,0);
  await f.advance(1000);assert.equal(calls,1);assert.equal(f.instance.pollTimer,null);assert.equal(f.instance.polling,false);
 }finally{cancelGate.resolve();await Promise.allSettled([release,originalSettlement].filter(Boolean));await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

// QueueInference may durably commit before its command proof settles. These
// controls drive the real controller/owned JSON readers with an explicit held
// command boundary and deterministic timer clock; they do not emulate the server.
const e4QueueBody=()=>({type:'QueueInference',reviewId:'review',token:'token',acceptanceId:'accepted'});

test('pending enqueue observes an initially empty then committed queue without claiming command completion',async t=>{
 const f=await paginationFixture(t),proof=previewDeferred(),observed=observeRequestAnnouncements(f),empty=structuredClone(f.pages.get('')),committed=queueObservation('completed');
 empty.jobs=[];empty.totalJobs=0;empty.nextCursor=null;committed.totalJobs=1;const fixtureRead=f.editor.json.bind(f.editor);
 f.editor.json=async(path,...args)=>path.includes('/candidates')?candidateObservation():fixtureRead(path,...args);await f.instance.inspectCandidates('job','attempt');await flush();const retainedCandidate=f.instance.candidateViews.get('attempt');assert(retainedCandidate,'A real independently owned candidate page is retained');
 const originalRead=f.editor.json.bind(f.editor);let candidates=0,reads=0,saved=0,settled=false;
 f.instance.resetQueuePage();f.instance.queue=null;f.host.requestUpdate();await flush();
 f.editor.json=(path,...args)=>path.includes('/candidates')?(candidates++,candidateObservation()):originalRead(path,...args);
 f.setReader(()=>++reads===1?empty:committed);f.editor.command=()=>proof.promise;
 const drafts=structuredClone(f.saved),entryBusy=f.instance.busy,command=f.instance.queueCommand(e4QueueBody(),()=>saved++);void command.then(()=>{settled=true;},()=>{settled=true;});
 try{
  await flush();assert.equal(f.instance.queueBusy,true);assert.equal(f.instance.message,'Saving request…');assert.equal(requestAnnouncement(f),'Saving request…');
  await f.advance(149);assert.equal(reads,0,'Pending observation keeps the original bounded cadence');await f.advance(1);
  assert.equal(reads,1);assert.deepEqual(f.instance.queue.jobs,[]);assert.equal(settled,false);assert.equal(saved,0);
  await f.advance(150);assert.equal(reads,2);assert.equal(f.instance.queue.jobs[0].id,committed.jobs[0].id);assert.equal(f.instance.queue.jobs[0].attempts[0].terminal,'completed');
  assert.equal(settled,false);assert.equal(saved,0);assert.equal(f.instance.queueBusy,true);assert.equal(f.instance.busy,entryBusy);assert.equal(f.instance.message,'Saving request…');assert.equal(requestAnnouncement(f),'Saving request…');
  assert.equal(f.instance.queueKnownTotal,null,'Observation is not an authoritative page refresh');assert.equal(f.instance.queueNewJobs,false);assert.equal(f.instance.candidateViews.size,1);assert.strictEqual(f.instance.candidateViews.get('attempt'),retainedCandidate,'An empty precommit page cannot prune separately owned candidates');assert.equal(candidates,0);assert.deepEqual(f.saved,drafts);assert.deepEqual(observed.focus,[]);
  assert(!observed.changes.some(value=>/accepted and saved|Queue change saved|could not be confirmed/.test(value)));
  proof.resolve([{type:'JobQueued',payload:{}},{type:'QueueStateChanged',payload:{}}]);await command;await flush();
  assert.equal(saved,1);assert.equal(settled,true);assert.equal(f.instance.queueBusy,false);assert.equal(f.instance.queueKnownTotal,1);assert.match(f.instance.message,/^Queue change saved locally\./);assert.deepEqual(observed.focus,[]);
 }finally{proof.resolve([]);f.setReader(null);await Promise.allSettled([command]);await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('pending enqueue keeps at most one unsettled observation across repeated timer turns',async t=>{
 const f=await paginationFixture(t),proof=previewDeferred(),read=previewDeferred();let reads=0;
 f.editor.command=()=>proof.promise;f.setReader(()=>{reads++;return read.promise;});const command=f.instance.queueCommand(e4QueueBody());
 try{
  await f.advance(150);assert.equal(reads,1);assert.equal(f.instance.inspectMemory().navigation.controls.reads,1);
  for(let turn=0;turn<5;turn++){f.instance.poll();await f.advance(150);assert.equal(reads,1);assert.equal(f.instance.inspectMemory().navigation.controls.reads,1);}
  read.resolve(f.pages.get(''));await flush();assert.equal(f.instance.inspectMemory().navigation.controls.reads,0);
  await f.advance(149);assert.equal(reads,1);await f.advance(1);assert.equal(reads,2,'A new observation waits for actual settlement plus the cadence');
  f.setReader(null);proof.resolve([]);await command;await flush();assert.equal(f.instance.queueBusy,false);
 }finally{read.resolve(f.pages.get(''));proof.resolve([]);f.setReader(null);await Promise.allSettled([command]);await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('pending enqueue does not introduce a second read beside an older ordinary queue poll',async t=>{
 const f=await paginationFixture(t),old=previewDeferred(),proof=previewDeferred();let reads=0,candidates=0;
 const json=f.editor.json.bind(f.editor);f.editor.json=(path,...args)=>path.includes('/candidates')?(candidates++,candidateObservation()):json(path,...args);
 const view=structuredClone(f.pages.get(''));view.jobs[0].attempts[0].requestId='known-provider-request';
 f.setReader(()=>{reads++;return reads===1?old.promise:view;});await f.advance(150);assert.equal(f.instance.polling,true);assert.equal(reads,1);
 f.editor.command=()=>proof.promise;const command=f.instance.queueCommand(e4QueueBody());
 try{
  await f.advance(600);assert.equal(reads,1);assert.equal(f.instance.inspectMemory().navigation.controls.reads,1);
  old.resolve(view);await flush();assert.equal(f.instance.polling,false);assert.equal(candidates,0);
  await f.advance(150);assert.equal(reads,2);assert.equal(candidates,0);assert.equal(f.instance.queueBusy,true);
  f.setReader(null);proof.resolve([]);await command;assert.equal(f.instance.queueBusy,false);
 }finally{old.resolve(view);proof.resolve([]);f.setReader(null);await Promise.allSettled([command]);await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('enqueue summary synchronously fences a late observation before owned event cleanup and the protected refresh',async t=>{
 const f=await paginationFixture(t),proof=previewDeferred(),late=previewDeferred(),cleanup=previewDeferred(),entered=previewDeferred(),finalRead=previewDeferred(),stale=queuePage('obsolete',null),finalView=queuePage('authoritative',null);
 let reads=0,saved=0;f.editor.command=()=>proof.promise;f.setReader(()=>++reads===1?late.promise:finalRead.promise);
 // Retain the fixture's actual owned event model and callback. This held
 // cleanup is outside that callback, exactly where the caller can yield.
 f.editor.withCommandEvents=async(body,work,...args)=>{const model=await f.editor.ownedCommand(body,...args);try{const result=work(model.value);late.resolve(stale);entered.resolve();await cleanup.promise;return result;}finally{model.release();}};
 const original=f.instance.queue,command=f.instance.queueCommand(e4QueueBody(),()=>saved++);
 try{
  await f.advance(150);assert.equal(reads,1);proof.resolve([{type:'JobQueued',payload:{}}]);await entered.promise;await flush();
  assert.strictEqual(f.instance.queue,original,'An old response cannot publish after the event callback has handed off');assert.equal(saved,0);assert.equal(f.instance.queueBusy,true);
  await f.advance(600);assert.equal(reads,1,'No pending timer survives the synchronous handoff');
  cleanup.resolve();await flush();assert.equal(reads,2,'Exactly the protected final refresh starts after event cleanup');
  await f.advance(600);assert.equal(reads,2,'The pending lane cannot supersede the protected refresh');
  finalRead.resolve(finalView);await command;await flush();assert.equal(f.instance.queue.jobs[0].id,'authoritative');assert.equal(saved,1);assert.equal(f.instance.queueBusy,false);assert.deepEqual(f.instance.issues,[]);assert.deepEqual(f.focus,[]);
 }finally{proof.resolve([]);late.resolve(stale);cleanup.resolve();finalRead.resolve(finalView);await Promise.allSettled([command]);await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('ordinary pending queue read failure stays observational and a later queue status is still admitted',async t=>{
 const f=await paginationFixture(t),proof=previewDeferred(),failure=Error('Pending read temporarily unavailable'),original=f.instance.queue,observed=observeRequestAnnouncements(f);let reads=0,saved=0;
 f.editor.command=()=>proof.promise;f.setReader(()=>{if(++reads===1)throw failure;return queuePage('later-committed',null);});const command=f.instance.queueCommand(e4QueueBody(),()=>saved++);
 try{
  await f.advance(150);assert.equal(reads,1);assert.strictEqual(f.instance.queue,original);assert.equal(f.instance.queueBusy,true);assert.equal(f.instance.message,'Saving request…');assert.deepEqual(f.instance.issues,[]);assert.deepEqual(observed.focus,[]);
  await f.advance(150);assert.equal(reads,2);assert.equal(f.instance.queue.jobs[0].id,'later-committed');assert.equal(saved,0);assert.equal(requestAnnouncement(f),'Saving request…');
  proof.resolve([]);await command;assert.equal(saved,1);assert.equal(f.instance.queueBusy,false);assert(!observed.changes.some(value=>value.includes('could not be confirmed')));
 }finally{proof.resolve([]);f.setReader(null);await Promise.allSettled([command]);await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('enqueue command rejection preserves the original error and retires its observation before later polling',async t=>{
 const f=await paginationFixture(t),proof=previewDeferred(),late=previewDeferred(),failure=Error('Exact enqueue proof rejection'),observed=observeRequestAnnouncements(f),original=f.instance.queue;let caught,saved=0,reads=0;
 f.editor.command=()=>proof.promise;f.setReader(()=>{reads++;return late.promise;});
 f.instance.action(event(),async()=>{try{await f.instance.queueCommand(e4QueueBody(),()=>saved++);}catch(error){caught=error;throw error;}});await f.advance(0);
 try{
  await f.advance(150);assert.equal(reads,1);proof.reject(failure);await flush();assert.strictEqual(caught,failure);assert.equal(f.instance.queueBusy,false);assert.equal(saved,0);assert.match(f.instance.message,/^Queue change could not be confirmed\./);assert.deepEqual(f.instance.issues,[{field:'review',code:'REVIEW',message:failure.message}]);assert.deepEqual(observed.focus,['#request-errors']);
  late.resolve(queuePage('late-rejected-command',null));await flush();assert.strictEqual(f.instance.queue,original,'Rejected command observation cannot subsequently publish');
  f.setReader(null);const before=f.reads.length;await f.advance(150);assert.equal(f.reads.length,before+1,'Existing normal observation resumes');assert.deepEqual(observed.focus,['#request-errors']);
 }finally{proof.resolve([]);late.resolve(f.pages.get(''));f.setReader(null);await flush();await Promise.allSettled([...f.instance.entryTasks]);await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('enqueue protected final refresh rejection retains its exact error after successful pending observations',async t=>{
 const f=await paginationFixture(t),proof=previewDeferred(),failure=Error('Exact final enqueue refresh rejection'),observed=observeRequestAnnouncements(f);let caught,reads=0,saved=0;
 f.editor.command=()=>proof.promise;f.setReader(()=>{reads++;return queuePage('observed-before-proof',null);});
 f.instance.action(event(),async()=>{try{await f.instance.queueCommand(e4QueueBody(),()=>saved++);}catch(error){caught=error;throw error;}});await f.advance(0);
 try{
  await f.advance(150);assert.equal(reads,1);assert.equal(f.instance.queue.jobs[0].id,'observed-before-proof');f.setReader(()=>{reads++;throw failure;});proof.resolve([{type:'JobQueued',payload:{}}]);await flush();
  assert.equal(reads,2);assert.strictEqual(caught,failure);assert.equal(saved,0);assert.equal(f.instance.queueBusy,false);assert.match(f.instance.message,/^Queue change could not be confirmed\./);assert.deepEqual(f.instance.issues,[{field:'review',code:'REVIEW',message:failure.message}]);assert.deepEqual(observed.focus,['#request-errors']);
 }finally{proof.resolve([]);f.setReader(null);await flush();await Promise.allSettled([...f.instance.entryTasks]);await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('explicit queue navigation retires a pending enqueue observation without changing the chosen page',async t=>{
 const f=await paginationFixture(t),proof=previewDeferred(),late=previewDeferred(),originalPath='/api/v1/queue',nextPath=originalPath+'?after='+encodeURIComponent(pageTwo);let originalReads=0;
 f.editor.command=()=>proof.promise;f.setReader(path=>path===originalPath?(originalReads++,late.promise):f.defaultRead(path));const command=f.instance.queueCommand(e4QueueBody());
 try{
  await f.advance(150);assert.equal(originalReads,1);await f.click('queue-next');assert.equal(f.instance.queueCursor,pageTwo);assert.equal(f.instance.queue.jobs[0].id,'middle');assert.deepEqual(f.focus,['#queue-page-status']);
  late.resolve(queuePage('late-first-page',null));await flush();assert.equal(f.instance.queueCursor,pageTwo);assert.equal(f.instance.queue.jobs[0].id,'middle');
  const reads=f.reads.length;await f.advance(600);assert.equal(f.reads.length,reads,'The original-page lane stays retired');assert.equal(f.instance.queueBusy,true);
  proof.resolve([{type:'JobQueued',payload:{}}]);await command;await flush();assert.equal(f.reads.at(-1),nextPath);assert.equal(pageNumber(f),2);assert.equal(f.instance.queue.jobs[0].id,'middle');assert.deepEqual(f.focus,['#queue-page-status']);
 }finally{late.resolve(f.pages.get(''));proof.resolve([]);f.setReader(null);await Promise.allSettled([command]);await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

for(const boundary of ['document','draft-owner','session'])test('pending enqueue observation cannot publish after '+boundary+' ownership replacement',async t=>{
 const f=await paginationFixture(t),proof=previewDeferred(),late=previewDeferred(),original=f.instance.queue;let reads=0;
 f.editor.command=()=>proof.promise;f.setReader(()=>{reads++;return late.promise;});const command=f.instance.queueCommand(e4QueueBody());
 try{
  await f.advance(150);assert.equal(reads,1);
  if(boundary==='document')f.editor.view.document={id:'replacement',revision:'1'};else if(boundary==='draft-owner')f.editor.draftOwner={drafts:new Map()};else f.editor.sessionId='replacement-session';
  late.resolve(queuePage('foreign-late',null));await flush();assert.strictEqual(f.instance.queue,original);const before=f.reads.length;await f.advance(600);assert.equal(f.reads.length,before);assert.deepEqual(f.focus,[]);
  proof.resolve([{type:'JobQueued',payload:{}}]);await command;await flush();assert.equal(f.reads.length,before);assert.strictEqual(f.instance.queue,original);
 }finally{late.resolve(f.pages.get(''));proof.resolve([]);f.setReader(null);await Promise.allSettled([command]);await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('confirmed deletion drains the original pending enqueue read and cannot revive its retired lane',async t=>{
 const f=await paginationFixture(t),proof=previewDeferred(),late=previewDeferred(),original=f.instance.queue;let reads=0,drained=false,lease;
 f.editor.command=()=>proof.promise;f.setReader(()=>{reads++;return late.promise;});const command=f.instance.queueCommand(e4QueueBody());
 try{
  await f.advance(150);assert.equal(reads,1);const originals=[...f.instance.observationTasks.keys()];assert(originals.length>0,'Pending enqueue read participates in the real observation registry');
  lease=f.instance.pauseDocumentObservation('doc');void lease.drain.then(()=>{drained=true;});await f.advance(600);assert.equal(drained,false);assert.equal(reads,1);
  late.resolve(queuePage('deleted-late',null));await lease.drain;await flush();assert.equal(drained,true);assert.strictEqual(f.instance.queue,original);assert.equal(f.instance.observationTasks.size,0);assert.equal(f.instance.inspectMemory().navigation.controls.reads,0);
  lease.release();await f.advance(600);assert.equal(reads,1,'Refused deletion may resume normal polling, but does not revive this command lane');assert.equal(f.instance.queueBusy,true);
  f.setReader(null);proof.resolve([]);await command;await flush();assert.equal(f.instance.queueBusy,false);const before=f.reads.length;await f.advance(150);assert.equal(f.reads.length,before+1);
 }finally{late.resolve(f.pages.get(''));proof.resolve([]);f.setReader(null);lease?.release();await Promise.allSettled([command,lease?.drain].filter(Boolean));await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('document release waits for pending enqueue native reader cancellation without claiming cleanup early',{timeout:5000},async t=>{
 const f=await paginationFixture(t),proof=previewDeferred(),entered=previewDeferred(),cancelGate=previewDeferred();let calls=0,cancels=0,signal,release,released=false,settlement;
 const body=new ReadableStream({pull(){entered.resolve();},cancel(){cancels++;return cancelGate.promise;}},{highWaterMark:0});
 f.editor.ownedJSON=(path,owner,init,current,maxBytes,kind)=>{assert.equal(path,'/api/v1/queue');calls++;signal=init.signal;const original=readOwnedJSON(async()=>new Response(body,{headers:{'content-length':'2'}}),path,{owner,init,owns:current,maxBytes,kind});settlement=Promise.allSettled([original]);return original;};
 f.editor.command=()=>proof.promise;const command=f.instance.queueCommand(e4QueueBody());
 try{
  await f.advance(150);await entered.promise;assert.equal(calls,1);assert.equal(body.locked,true);assert.equal(signal.aborted,false);
  release=f.instance.releaseDocument();void release.then(()=>{released=true;},()=>{});assert.equal(signal.aborted,true);await f.advance(600);
  assert.equal(cancels,1);assert.equal(released,false);assert.equal(body.locked,true);assert.equal(calls,1);assert.equal(f.instance.inspectMemory().navigation.controls.reads,1,'The real cancellation promise remains owned');
  cancelGate.resolve();await release;const [result]=await settlement;assert.equal(result.status,'rejected');assert.match(result.reason.message,/PROMPT_READ_STALE/);assert.equal(body.locked,false);assert.equal(released,true);assert.equal(cancels,1);
  proof.resolve([{type:'JobQueued',payload:{}}]);await command;await f.advance(600);assert.equal(calls,1);assert.equal(f.instance.queue,null);assert.equal(f.instance.candidateViews.size,0);assert.equal(f.instance.observationTasks.size,0);assert.deepEqual(f.instance.inspectMemory().navigation.controls,{models:0,reads:0,pending:0,cleanupFailures:0});
 }finally{cancelGate.resolve();proof.resolve([]);await Promise.allSettled([command,release,settlement].filter(Boolean));await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

test('non-enqueue queue commands keep the original no-pending-observation behavior',async t=>{
 const f=await paginationFixture(t),proof=previewDeferred(),body={type:'CancelJob',jobId:'newest',attemptId:'attempt-newest',expectedVersion:'1'};let reads=0;
 f.editor.command=()=>proof.promise;f.setReader(()=>{reads++;return f.pages.get('');});const command=f.instance.queueCommand(body);
 try{
  await f.advance(600);assert.equal(reads,0);assert.equal(f.instance.queueBusy,true);assert.equal(f.instance.message,'Saving cancellation request…');
  proof.resolve([]);await command;assert.equal(reads,1,'Only the existing receipt-following refresh occurs');assert.equal(f.instance.queueBusy,false);
 }finally{proof.resolve([]);f.setReader(null);await Promise.allSettled([command]);await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

// Manual refresh owns an authoritative page independently of ordinary polling.
// Both response orders preserve that priority; only a newly issued observation
// after actual refresh settlement may update status again.
test('manual queue refresh already in flight has priority over a newly pending enqueue observer',async t=>{
 const f=await paginationFixture(t),manual=previewDeferred(),proof=previewDeferred(),manualView=queuePage('manual-before-enqueue',null);let reads=0;
 f.setReader(()=>++reads===1?manual.promise:manualView);const refresh=f.instance.refreshQueue();const refreshResult=Promise.allSettled([refresh]);await flush();assert.equal(reads,1);assert.equal(f.instance.inspectMemory().navigation.controls.reads,1);
 f.editor.command=()=>proof.promise;const command=f.instance.queueCommand(e4QueueBody());
 try{
  await f.advance(600);assert.equal(reads,1,'A new pending lane cannot overlap the original manual read');assert.equal(f.instance.inspectMemory().navigation.controls.reads,1);assert.equal(f.instance.queueBusy,true);
  manual.resolve(manualView);await refresh;await flush();assert.equal(f.instance.queue.jobs[0].id,'manual-before-enqueue');assert.equal(f.instance.inspectMemory().navigation.controls.reads,0);assert.deepEqual(f.focus,[]);
  proof.resolve([]);await command;assert.equal(reads,2,'The saved command retains its one authoritative final refresh');assert.equal(f.instance.queue.jobs[0].id,'manual-before-enqueue');assert.equal(f.instance.queueBusy,false);
 }finally{manual.resolve(manualView);proof.resolve([]);f.setReader(null);await Promise.allSettled([command,refreshResult]);await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});

for(const order of ['manual-first','pending-first'])test('manual queue refresh fences a held pending enqueue response and resumes only after settlement: '+order,async t=>{
 const f=await paginationFixture(t),proof=previewDeferred(),old=previewDeferred(),manual=previewDeferred(),fresh=previewDeferred(),oldView=queuePage('obsolete-pending',null),manualView=queuePage('manual-authority',null),freshView=queuePage('new-observation',null);let reads=0,refresh;
 f.editor.command=()=>proof.promise;f.setReader(()=>{reads++;return reads===1?old.promise:reads===2?manual.promise:reads===3?fresh.promise:freshView;});const command=f.instance.queueCommand(e4QueueBody());
 try{
  await f.advance(150);assert.equal(reads,1);refresh=f.instance.refreshQueue();void refresh.catch(()=>{});await flush();assert.equal(reads,2,'The explicitly requested manual read is admitted');assert.equal(f.instance.inspectMemory().navigation.controls.reads,2);
  if(order==='manual-first'){
   manual.resolve(manualView);await refresh;await flush();assert.equal(f.instance.queue.jobs[0].id,'manual-authority');
   await f.advance(600);assert.equal(reads,2,'The still-held old observation does not permit another observation');old.resolve(oldView);await flush();
   assert.equal(f.instance.queue.jobs[0].id,'manual-authority','Late older bytes cannot overwrite the completed manual refresh');
  }else{
   const retained=f.instance.queue;old.resolve(oldView);await flush();assert.strictEqual(f.instance.queue,retained,'The in-flight manual read already fences old observation publication');
   await f.advance(600);assert.equal(reads,2,'Settling the old status read does not allow a later timer to join the unsettled manual refresh');assert.equal(f.instance.inspectMemory().navigation.controls.reads,1);
   manual.resolve(manualView);await refresh;await flush();assert.equal(f.instance.queue.jobs[0].id,'manual-authority');
  }
  assert.equal(f.instance.queueBusy,true);assert.equal(f.instance.inspectMemory().navigation.controls.reads,0);assert.deepEqual(f.focus,[]);
  await f.advance(150);assert.equal(reads,3,'Only a fresh post-refresh observation resumes');fresh.resolve(freshView);await flush();assert.equal(f.instance.queue.jobs[0].id,'new-observation');assert.equal(f.instance.queueBusy,true);assert.equal(f.instance.message,'Saving request…');
  proof.resolve([]);await command;assert.equal(reads,4);assert.equal(f.instance.queueBusy,false);assert.equal(f.instance.queue.jobs[0].id,'new-observation');assert.deepEqual(f.focus,[]);
 }finally{old.resolve(oldView);manual.resolve(manualView);fresh.resolve(freshView);proof.resolve([]);f.setReader(null);await Promise.allSettled([command,refresh].filter(Boolean));await f.instance.dispose();await flush();assertReleasedRequestStatus(f);}
});


test('pending enqueue native unlock failure stops observation and retains cleanup debt until explicit successful release',async t=>{
 const f=await paginationFixture(t),proof=previewDeferred(),unlockFailure=Error('Exact native reader unlock refusal'),commandFailure=Error('Exact enqueue command refusal after diagnostic failure'),reported=[];
 const originalOwnedJSON=f.editor.ownedJSON.bind(f.editor),wire=JSON.stringify(f.pages.get('')),bytes=new TextEncoder().encode(wire);let allowUnlock=false,reads=0,unlocks=0,reader,restoreReader,lease,firstRelease;
 const body=new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),getReader=body.getReader;
 // Keep the native response, reader, reads, cancellation and owner accounting.
 // Only the documented native unlock boundary refuses until explicitly repaired.
 Object.defineProperty(body,'getReader',{configurable:true,value:function(...args){reader=Reflect.apply(getReader,this,args);const releaseLock=reader.releaseLock;restoreReader=()=>{delete reader.releaseLock;};Object.defineProperty(reader,'releaseLock',{configurable:true,value:function(){unlocks++;if(!allowUnlock)throw unlockFailure;return Reflect.apply(releaseLock,this,[]);}});return reader;}});
 f.editor.ownedJSON=(path,owner,init,current,maxBytes,kind)=>{assert.equal(path,'/api/v1/queue');reads++;return readOwnedJSON(async()=>new Response(body,{headers:{'content-length':String(bytes.length)}}),path,{owner,init,owns:current,maxBytes,kind});};
 f.editor.fail=error=>reported.push(error);f.editor.command=()=>proof.promise;const command=f.instance.queueCommand(e4QueueBody()),commandResult=Promise.allSettled([command]);
 try{
  await f.advance(150);assert.equal(reads,1);assert.equal(reported.length,1);const cleanup=reported[0];assert.equal(cleanup.message,'PROMPT_READER_CLEANUP_FAILED');assert(cleanup.errors.includes(unlockFailure));assert.equal(cleanup.cancellationFailed,false,'This is repairable unlock debt, not invented cancellation success');assert.equal(body.locked,true);assert(unlocks>=2);assert.equal(f.instance.inspectMemory().navigation.controls.cleanupFailures,1);assert.equal(f.instance.queueBusy,true);
  await f.advance(600);assert.equal(reads,1,'Failed reader cleanup forbids another pending observation');assert.equal(reported.length,1,'The original failure is reported once');assert.equal(f.instance.message,'Saving request…');
  lease=f.instance.pauseDocumentObservation('doc');const [deletion]=await Promise.allSettled([lease.drain]);assert.equal(deletion.status,'rejected');assert.match(deletion.reason.message,/Request observation cleanup is incomplete/);assert.equal(f.instance.inspectMemory().navigation.controls.cleanupFailures,1);assert.equal(body.locked,true);lease.release();
  proof.reject(commandFailure);const [result]=await commandResult;assert.equal(result.status,'rejected');assert.strictEqual(result.reason,commandFailure,'A status cleanup failure cannot replace the original command failure');assert.equal(f.instance.queueBusy,false);assert.strictEqual(reported[0],cleanup);
  f.editor.ownedJSON=originalOwnedJSON;firstRelease=f.instance.releaseDocument();await assert.rejects(firstRelease,/REQUEST_RELEASE_INCOMPLETE/);await flush();assert.equal(body.locked,true);assert.equal(f.instance.inspectMemory().navigation.controls.cleanupFailures,1,'Unsuccessful release keeps the actual original cleanup owner');
  allowUnlock=true;await f.instance.dispose();await flush();assert.equal(body.locked,false);assert.equal(f.instance.inspectMemory().navigation.controls.cleanupFailures,0);assert.equal(f.instance.observationTasks.size,0);assertReleasedRequestStatus(f);await f.advance(600);assert.equal(reads,1);
 }finally{allowUnlock=true;proof.resolve([]);lease?.release();f.editor.ownedJSON=originalOwnedJSON;await Promise.allSettled([commandResult,firstRelease].filter(Boolean));try{await f.instance.dispose();await flush();}finally{restoreReader?.();delete body.getReader;}assertReleasedRequestStatus(f);}
});

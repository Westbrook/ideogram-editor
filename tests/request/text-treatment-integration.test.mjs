// Actual request, request-edit, text-treatment and candidate-treatment controllers,
// ControlAdapter, immutable request entries and model ledger. Lit, display decode,
// provider/server transport and unrelated V45/adapter/native panels are explicit
// NON-BROWSER boundaries. This suite does not qualify browser pixels or focus.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,posix} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseSync,transformWithOxc} from 'vite';
import {allocationsURL,promptMemoryURL,diagnosticMemoryURL,compositionObservationsURL,phasesURL,workerPhasesURL,browserPhasesURL,ownedPreviewURL} from '../owned-preview-module.mjs';
import {displayControlURL} from '../display-module.mjs';
import {newDraft,hash} from '../../dist/local/src/request/core.js';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {emptyComposition,emptyElement,serialize} from '../../dist/local/src/composition/core.js';
import {planTextTreatment,textTreatmentPlanRef,bindTextTreatmentEnvelope} from '../../dist/local/src/request/text-treatment.js';

// Execute against the complete effective source tree; a corrections directory
// can overlay it without mixing a new controller with an old dependency graph.
const roots=[process.env.REQUEST_PROMPT_ROOT,process.env.REQUEST_RESPONSES_ROOT,process.env.TEXT_TREATMENT_CORRECTION_ROOT,process.env.TEXT_TREATMENT_SOURCE_ROOT,'.'].filter(Boolean);
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const lit=data('export const nothing=null;export const noChange=Symbol.for("lit-noChange");export const html=(strings,...values)=>({strings,values});export const svg=html;');
const displayURL=data(`
 import {readOwnedDisplayControl,DISPLAY_SOURCE_CONTROL_BYTES} from ${JSON.stringify(displayControlURL)};
 export const created=[],released=[],reads=[],validated=[];export let failId=null;export let delay=null;let releaseFailure=null;
 export const fail=value=>failId=value;export const pending=value=>delay=value;export const failRelease=value=>releaseFailure=value;
 export async function readDisplaySource(_transport,id,options){reads.push(id);if(options?.owns&&!options.owns())throw new DOMException('stale','AbortError');return {assetId:id};}
 export async function withDisplaySource(transport,id,options,consume){const owner=await readOwnedDisplayControl('fixture-display-source',DISPLAY_SOURCE_CONTROL_BYTES,()=>readDisplaySource(transport,id,options));try{return await consume(owner.value);}finally{owner.release();}}
 export async function createDisplayPreviewURL(_transport,source,options){if(source.assetId===failId)throw Error('DISPLAY_TEST_FAILURE');if(delay)await delay;if(options.signal?.aborted||options.owns&&!options.owns())throw new DOMException('stale','AbortError');const url='blob:lettering/'+source.assetId+'/'+created.length;created.push(url);return url;}
 export function revokeDisplayPreviewURL(url){if(!url)return;if(url===releaseFailure){releaseFailure=null;throw Error('DISPLAY_RELEASE_TEST_FAILURE');}if(released.includes(url))throw Error('DOUBLE_URL_RELEASE');released.push(url);}
 export function displayPreviewInfo(url){return created.includes(url)&&!released.includes(url)?{width:4,height:4,sourceWidth:4,sourceHeight:4}:undefined;}
 export function validateDisplayImage(image,url){if(typeof image!=='object'||typeof url!=='string'||image.currentSrc!==url||image.naturalWidth!==4||image.naturalHeight!==4||!displayPreviewInfo(url))throw Error('DISPLAY_ARGUMENT_ORDER_OR_IDENTITY');validated.push(url);}
 export async function retryDisplayPreviewCleanup(){}
`),display=await import(displayURL);
const unrelated={
 'src/ui/adapter-library.ts':data('export class AdapterLibraryEditing{constructor(){} async eligibility(){return undefined;} render(){return null;} async dispose(){}}'),
 'src/ui/request-v45-edit.ts':data('export class V45EditInputsEditing{constructor(){} render(){return null;} dispose(){} } export const renderV45EditSettings=()=>null,renderV45EditReview=()=>null;'),
 'src/ui/request-v45.ts':data('export const renderV45Generation=()=>null,renderV45GenerationReview=()=>null,renderV45UnavailableResultMetadata=()=>null,renderRequestEstimate=()=>null;'),
 'src/ui/returned-description.ts':data('export class ReturnedDescriptionEditing{constructor(host,editor,open){this.open=open;}render(){return null;}async releaseDocument(){}}'),
 'src/ui/display-image.ts':data('export const displayImage=value=>value;'),
 'src/observability/display-preview.ts':displayURL,
};
// Reuse the actual diagnostic graph, including the central ledger that adopts
// its import-time owners, across every recursively loaded controller dependency.
const modules=new Map([...Object.entries(unrelated),
 ['src/observability/allocations.ts',allocationsURL],
 ['src/observability/prompt-memory.ts',promptMemoryURL],
 ['src/observability/diagnostic-memory.ts',diagnosticMemoryURL],
 ['src/observability/composition-observations.ts',compositionObservationsURL],
 ['src/observability/phases.ts',phasesURL],
 ['src/observability/browser-worker-observations.ts',workerPhasesURL],
 ['src/observability/browser.ts',browserPhasesURL],
 ['src/observability/owned-preview.ts',ownedPreviewURL],
]);
async function sourceText(path){for(const root of roots){try{return await readFile(root+'/'+path,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}}throw Error('Missing effective source '+path);}
async function moduleURL(path){
 if(modules.has(path))return modules.get(path);
 let code=(await transformWithOxc(await sourceText(path),path)).code;
 const parsed=parseSync(path,code,{lang:'js'});if(parsed.errors.length)throw Error('Invalid transformed controller fixture '+path);
 // Parse declarations so authored template text cannot become a module edge.
 const declarations=parsed.program.body.filter(node=>['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source).reverse();
 for(const node of declarations){const specifier=node.source.value;let url;
  if(node.type==='ImportDeclaration'&&node.specifiers.length===0&&specifier.endsWith('.css')){code=code.slice(0,node.start)+code.slice(node.end);continue;}
  if(specifier==='lit')url=lit;
  else if(specifier==='lit/directives/repeat.js')url=data('export const repeat=(items,key,render)=>Array.from(items,render);');
  else if(specifier.startsWith('.')){const dependency=posix.normalize(posix.join(posix.dirname(path),specifier)).replace(/\.js$/,'.ts');url=dependency.startsWith('src/ui/')||dependency.startsWith('src/observability/')||dependency==='src/composition/memory.ts'?await moduleURL(dependency):pathToFileURL(resolve('dist/local/'+dependency.replace(/\.ts$/,'.js'))).href;}
  else throw Error('Undeclared controller fixture dependency '+specifier);
  code=code.slice(0,node.source.start)+JSON.stringify(url)+code.slice(node.source.end);
 }
 const url=data(code);modules.set(path,url);return url;
}
const {RequestEditing}=await import(await moduleURL('src/ui/request.ts'));
const {RequestEdits}=await import(await moduleURL('src/ui/request-edits.ts'));
const returnedStub=modules.get('src/ui/returned-description.ts');modules.delete('src/ui/returned-description.ts');
const {ReturnedDescriptionEditing}=await import(await moduleURL('src/ui/returned-description.ts'));modules.set('src/ui/returned-description.ts',returnedStub);
const {readOwnedJSON,createOwnedModel,modelPayloadBytes}=await import(await moduleURL('src/observability/model-memory.ts'));
const {allocationLedger}=await import(await moduleURL('src/observability/allocations.ts'));
const flush=async()=>{for(let n=0;n<64;n++)await Promise.resolve();};
const turn=async()=>{await new Promise(resolve=>setTimeout(resolve,0));await new Promise(setImmediate);await flush();};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
// The reader may reject at its stream fence before the caller's AbortError fence.
const isStaleRead=error=>error instanceof DOMException&&error.name==='AbortError'||error instanceof Error&&error.name==='Error'&&error.message==='PROMPT_READ_STALE';
const ref=(text,mediaType='application/json',byteLength=String(Buffer.byteLength(text)))=>({hash:hash(text),mediaType,byteLength});
const resources=()=>{const s=allocationLedger.snapshot();return {cpu:s.cpuBytes,prompt:s.promptBytes,records:s.activeRecords,handles:s.handles};};
function event(value='',checked=false){const target={value,checked,isConnected:true};return {currentTarget:target,composedPath:()=>[target],defaultPrevented:false,timeStamp:123};}
function rendered(template){
 const slots=[],expand=value=>value===null||value===undefined?'':Array.isArray(value)?value.map(expand).join(''):value?.strings?value.strings.reduce((all,text,i)=>all+text+(i<value.values.length?expand(value.values[i]):''),''):'__slot'+(slots.push(value)-1)+'__';
 const markup=expand(template),text=value=>value.replace(/__slot(\d+)__/g,(_,i)=>String(slots[Number(i)]));
 const binding=(attrs,name)=>{const match=new RegExp(name+'=__slot(\\d+)__').exec(attrs);return match?slots[Number(match[1])]:undefined;};
 const attr=(attrs,name)=>{const match=new RegExp('(?:^|\\s)'+name+'=(?:"([^"]*)"|([^ >]+))').exec(attrs);return match?text(match[1]??match[2]):null;};
 return {text:text(markup.replace(/<[^>]+>/g,'')),controls:[...markup.matchAll(/<(en-button|en-select|en-checkbox)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map(([,tag,attrs,label])=>({tag,id:attr(attrs,'id'),label:text(label.replace(/<[^>]+>/g,'')),disabled:!!binding(attrs,'\\?disabled'),click:binding(attrs,'@click'),change:binding(attrs,'@en-change')})),images:[...markup.matchAll(/<img\b([^>]*)>/g)].map(([,attrs])=>({src:attr(attrs,'src'),alt:attr(attrs,'alt'),load:binding(attrs,'@load'),error:binding(attrs,'@error'),displayError:binding(attrs,'@ie-display-error')}))};
}
async function choose(tree,id,value='',checked=false){const control=rendered(tree()).controls.find(row=>row.id===id);assert(control,'Rendered '+id);assert.equal(control.disabled,false,id);assert.equal(typeof control.change,'function');control.change(event(value,checked));await flush();}
async function click(tree,id){const control=rendered(tree()).controls.find(row=>row.id===id||row.label===id);assert(control,'Rendered '+id);assert.equal(control.disabled,false,id);assert.equal(typeof control.click,'function');control.click(event());await turn();}
async function loaded(tree){const images=rendered(tree()).images;assert(images.length);for(const image of images){assert.equal(typeof image.load,'function');image.load({currentTarget:{src:image.src,currentSrc:image.src,naturalWidth:4,naturalHeight:4}});}await flush();}
function ownJSON(editor,read){const transport=async(path,init)=>{const value=await read(path,init),bytes=Buffer.from(JSON.stringify(value));return new Response(bytes,{headers:{'content-length':String(bytes.length),'content-type':'application/json'}});};editor.ownedJSON=(path,owner,init,owns,maxBytes,kind='control')=>readOwnedJSON(transport,path,{owner,init,owns,maxBytes,kind});}

async function requestFixture(t,{native=true,semantic=false,sourceIds=null,mask=null}={}){
 const before=resources(),urlStart=display.created.length,releasedStart=display.released.length,reads=[],saved=[],reviews=[],commands=[],opened=[],errors=[],manifests=new Map(),responseOwners=[];let instance,serial=0,readOverride=null,saveOverride=null,reviewOverride=null,uiPins=0;
 // Persistence is a fixture seam; registrations still belong to the exact
 // draft owner and stay live through every Entry and native-input borrower.
 const registrations=new Map();
 const checkpoint={drafts:[]},uiModel=createOwnedModel('fixture-ui-checkpoint',modelPayloadBytes(checkpoint),()=>structuredClone(checkpoint),'control');
 function ownResponse(value,label){const model=createOwnedModel('fixture-'+label,modelPayloadBytes(value),()=>structuredClone(value),'control'),row={released:false};responseOwners.push(row);return {value:model.value,pin:()=>model.pin(),release(){assert.equal(row.released,false,'Response owner releases exactly once');row.released=true;model.release();}};}
 const imageVersion={state:ref('image-state'),semanticDigest:hash('image-state'),compositeAssetId:'visible'},document={id:'document',revision:'7',width:4,height:4,image:imageVersion};
 const layers=[{id:'background',version:'1',kind:'image',name:'Background',visible:true,locked:false,assetId:'background-asset',layerToDocument:[1,0,0,1,0,0],opacity:1,mask:null},...(native?[{id:'native',version:'1',kind:'text',name:'Native letters',visible:true,locked:false,assetId:'native-asset',layerToDocument:[1,0,0,1,1,1],opacity:0.75,mask:null,source:ref('native-source')}]:[])];
 const composition=emptyComposition(4,4,'composition');if(semantic){const included=emptyElement('text','semantic-included'),excluded=emptyElement('text','semantic-excluded');included.text.value='Included Café';excluded.text.value='Excluded 東京';excluded.excluded=true;composition.elements=[included,excluded];const projection=serialize(composition,[],{}),prompt=ref(projection.prompt,'text/plain');composition.review={serializer:'caption-json-1',sourceId:composition.id,frame:composition.frame,request:composition.request,dependencies:projection.dependencies,boxes:projection.boxes,prompt};}
 const editor={view:{ready:true,document,image:{schemaVersion:5,width:4,height:4,layers,composition:semantic?{id:composition.id,value:ref(canonical(composition)),bindings:{}}:null},selected:['background']},sessionId:'session',session:{identity:()=> 'client',transport:()=>assert.fail('Unexpected unowned transport')},draftOwner:{drafts:new Map()},ui:uiModel.value,pinUI(){const release=uiModel.pin();uiPins++;let active=true;return ()=>{assert(active,'UI checkpoint pin releases exactly once');active=false;uiPins--;release();};},pinViewModels:()=>()=>{},
  registerDraft(id,documentId){
   const owner=this.draftOwner;if(!owner||this.view.document?.id!==documentId)throw Error('DRAFT_OWNER_CHANGED');
   let owned=registrations.get(owner);if(!owned){owned=new Map();registrations.set(owner,owned);}let slot=owned.get(id);if(slot&&slot.documentId!==documentId)throw Error('DRAFT_DOCUMENT_CHANGED');if(!slot){slot={documentId,count:0};owned.set(id,slot);}slot.count++;let live=true;
   return ()=>{if(!live)return;live=false;if(--slot.count===0)owned.delete(id);if(owned.size===0)registrations.delete(owner);};
  },
  changeDraft(id,kind,wire,target,composing,revision){saved.push({id,kind,wire,target,composing,revision});const generation=String(saved.length);editor.draftOwner.drafts.set(id,{generation,savedGeneration:null});if(saveOverride)saveOverride();},
  async flushDrafts(){for(const draft of editor.draftOwner.drafts.values())draft.savedGeneration=draft.generation;},
  requestReview(){assert.fail('Request reviews must return an owned receipt');},
  async ownedRequestReview(body){reviews.push(structuredClone(body));const value={review:{kind:body.textTreatment?'request-review-text-1':'request-review-1',id:'review',token:hash('token'),request:{kind:'generate'},prompt:ref('prompt','text/plain'),estimate:{unknown:[]}}};return ownResponse(reviewOverride?reviewOverride(body,value):value,'request-review');},
  command(){assert.fail('Request source capture must use scoped command events');},
  async withCommandEvents(body,consume,target){commands.push({body:structuredClone(body),target:structuredClone(target)});assert.equal(body.type,'PrepareRequestSource');const ids=body.scope==='visible-document'?layers.filter(l=>l.visible).map(l=>l.id):body.layerIds,model=ownResponse([{type:'AssetRegistered',payload:{asset:capture('capture-'+(++serial),body.scope,ids).asset}}],'command-events');try{return await consume(model.value);}finally{model.release();}},
 };
 function capture(id,scope,ids){const pixels=ref(id+'-pixels','application/x-ideogram-rgba8','64'),value={width:4,height:4,pixels,plan:{kind:'request-source-capture-v1',capture:{schemaVersion:1,documentId:document.id,documentRevision:document.revision,image:imageVersion,scope,layerIds:ids}}},manifest=ref(canonical(value)),asset={id,version:'1',blob:ref(id+'png','image/png'),availability:'available',qualification:'canonical-raster',safety:'safe',raster:{manifest,pixels,role:'composite',width:4,height:4}};manifests.set(id,value);return {asset,source:{assetId:id,version:'1',blob:asset.blob,pixels,width:4,height:4,scope,documentRevision:document.revision,capture:manifest}};}
 ownJSON(editor,async(path,init)=>{reads.push(path);if(readOverride)return readOverride(path,init);if(path.endsWith('/request-reviews'))return {items:[]};if(path.includes('/composition?'))return {composition,bindings:{},layers:[]};const id=/\/assets\/([^/]+)\/raster$/.exec(path)?.[1];if(id&&manifests.has(id))return manifests.get(id);throw Error('Unexpected metadata '+path);});
 const host={updateComplete:Promise.resolve(),requestUpdate(){this.updateComplete=Promise.resolve();},querySelector(selector){return selector==='#prompt'?null:{focus(){}};}};
 instance=new RequestEditing(host,editor,undefined,async(trigger,proposal)=>opened.push({trigger,proposal}),()=>opened.push({composition:true}));await instance.sync();
 instance.error=error=>errors.push(error);
 instance.mutateEntry('Exact local prompt',next=>{next.text='Exact local prompt';if(sourceIds){next.draft.operation='inpaint';next.draft.source=capture('original',sourceIds.length===1?'single-layer':'selected-layers',sourceIds).source;next.draft.mask=mask;}});
 const helper=()=>instance.textTreatment,tree=()=>helper().render();tree();await flush();
 t.after(async()=>{display.fail(null);display.pending(null);await instance.dispose();await flush();assert.equal(registrations.size,0,'Every owner-scoped draft registration released');assert.equal(uiPins,0,'Restoration releases its checkpoint pin');uiModel.release();assert(responseOwners.every(row=>row.released),'All fixture response owners release');assert.deepEqual(resources(),before);assert.deepEqual(display.released.slice(releasedStart).sort(),display.created.slice(urlStart).sort());});
 return {instance,editor,host,saved,reviews,commands,opened,errors,reads,composition,manifests,capture,helper,tree,setRead:fn=>readOverride=fn,setSave:fn=>saveOverride=fn,setReview:fn=>reviewOverride=fn};
}
async function overlay(f){await choose(f.tree,'text-treatment-kind','native-overlay');await choose(f.tree,'text-treatment-retain-native','',true);}
async function confirmTreatment(f){await click(f.tree,'text-treatment-prepare');await loaded(f.tree);await click(f.tree,'text-treatment-confirm');assert.deepEqual(f.errors,[]);assert(f.helper().intent());}

for(const kind of ['native','semantic'])test('request command boundary requires explicit '+kind+' treatment before saving or reviewing',async t=>{
 const f=await requestFixture(t,{native:kind==='native',semantic:kind==='semantic'}),saved=f.saved.length;
 await assert.rejects(f.instance.prepare(),/Prepare and confirm native and semantic/);assert.equal(f.saved.length,saved);assert.deepEqual(f.reviews,[]);
});

test('confirmed treatment survives saveEntry identity and binds the exact saved generation and unchanged prompt bytes',async t=>{
 const f=await requestFixture(t);await overlay(f);await confirmTreatment(f);
 const entry=f.instance.entry(),draft=entry.draft,intent=f.helper().intent(),before=canonical(draft),text=entry.text;
 await f.instance.prepare();assert.equal(f.reviews.length,1);assert.equal(f.instance.entry(),entry);assert.equal(f.instance.entry().draft,draft);assert.equal(f.helper().intent(),intent);
 assert.deepEqual(f.reviews[0].textTreatment,intent);assert.notEqual(f.reviews[0].textTreatment,intent);assert.equal(f.reviews[0].generation,f.editor.draftOwner.drafts.get(entry.id).savedGeneration);
 const saved=JSON.parse(f.saved.at(-1).wire);assert.equal(saved.text,text);assert.equal(canonical(saved.draft),before);assert.equal(canonical(draft),before);
});

test('semantic inventory loads explicitly, contains included and excluded literals, and fences changed Composition revisions',async t=>{
 const f=await requestFixture(t,{semantic:true});assert.throws(()=>f.instance.treatmentSemanticView(),/Load the current semantic/);assert.equal(f.reads.some(path=>path.includes('/composition?')),false);
 await f.instance.loadTreatmentSemantics();assert.deepEqual(f.instance.treatmentSemanticView().items,[{id:'semantic-included',label:'Included Café'},{id:'semantic-excluded',label:'Excluded 東京'}]);assert.deepEqual(f.instance.treatmentSemanticView().approvedExcludedIds,['semantic-excluded']);
 await overlay(f);await click(f.tree,'text-treatment-prepare');assert.match(f.errors.pop().message,/Explicitly exclude every semantic/);assert.equal(f.commands.length,0);
 for(const id of ['semantic-included','semantic-excluded'])await choose(f.tree,'text-treatment-semantic-'+id,'',true);
 await confirmTreatment(f);const intent=f.helper().intent();assert.deepEqual(intent.choice.excludedSemanticIds,['semantic-included','semantic-excluded']);await f.instance.prepare();assert.deepEqual(f.reviews[0].textTreatment.choice.excludedSemanticIds,intent.choice.excludedSemanticIds);
 f.editor.view.document={...f.editor.view.document,revision:'8'};assert.throws(()=>f.instance.treatmentSemanticView(),/Load the current semantic/);assert.equal(f.helper().intent(),undefined);
});

test('approved Composition prompt keeps its included literal and exact bytes while treatment matches only its reviewed exclusions',async t=>{
 const f=await requestFixture(t,{semantic:true});await f.instance.composition();await f.instance.loadTreatmentSemantics();
 const entry=f.instance.entry(),expected=serialize(f.composition,[],{}).prompt;assert.equal(entry.text,expected);assert.equal(entry.draft.prompt.mode,'composition');assert.equal(entry.draft.prompt.text.hash,hash(expected));
 await overlay(f);await click(f.tree,'text-treatment-prepare');assert.match(f.errors.pop().message,/Composition editor/);
 await choose(f.tree,'text-treatment-semantic-semantic-excluded','',true);await confirmTreatment(f);await f.instance.prepare();
 assert.deepEqual(f.reviews[0].textTreatment.choice.excludedSemanticIds,['semantic-excluded']);assert.equal(f.instance.entry().text,expected);assert.equal(JSON.parse(f.saved.at(-1).wire).text,expected);assert.match(expected,/Included Café/);assert.doesNotMatch(expected,/Excluded 東京/);
});

for(const boundary of ['owner','revision'])test('pending semantic load releases stale '+boundary+' result without caching or replacing successor state',async t=>{
 const f=await requestFixture(t,{semantic:true}),pending=deferred();f.setRead(()=>pending.promise);const work=f.instance.loadTreatmentSemantics();await flush();
 if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};else f.editor.view.document={...f.editor.view.document,revision:'8'};
 pending.resolve({composition:f.composition});await assert.rejects(work,isStaleRead);assert.equal(f.instance.treatmentSemantics,null);
});

test('unchanged masked source can be explicitly reapproved; changed source still requires detachment before capture',async t=>{
 const f=await requestFixture(t,{sourceIds:['background'],mask:{assetId:'existing-mask'}}),draft=f.instance.entry().draft,mask=draft.mask,source=draft.source;
 await overlay(f);await choose(f.tree,'text-treatment-placement','current-document');assert.equal(rendered(f.tree()).controls.find(c=>c.id==='text-treatment-prepare').disabled,false);
 await confirmTreatment(f);assert.equal(f.instance.entry().draft,draft);assert.equal(draft.mask,mask);assert.equal(draft.source,source);assert.equal(f.commands.length,1,'unchanged subset needs only the visible baseline');
 f.instance.mutateEntry(null,next=>{next.draft.source=f.capture('with-native','selected-layers',['background','native']).source;});f.tree();await flush();
 const commands=f.commands.length;await click(f.tree,'text-treatment-prepare');assert.match(f.errors.at(-1).message,/Detach the current request mask/);assert.equal(f.commands.length,commands);assert.equal(f.instance.entry().draft.mask.assetId,'existing-mask');
});

test('native description bridge forwards the exact deliberate proposal and Composition action opens its inspector callback',async t=>{
 const f=await requestFixture(t),trigger={},proposal={literal:'Local Café',frame:{width:40,height:20},placement:{x:8,y:12},descriptionIntent:{kind:'returned-text-proposal'}};
 await f.instance.returnedDescription.open(trigger,proposal);assert.deepEqual(f.opened,[{trigger,proposal}]);assert.equal(f.opened[0].proposal,proposal);
 await click(f.tree,'text-treatment-open-composition');assert.deepEqual(f.opened.at(-1),{composition:true});assert.deepEqual(f.reviews,[]);
});

function candidatePlan(){
 const layers=[{id:'native',version:'1',kind:'text',visible:true,locked:false,stateHash:hash('layer'),contribution:{manifest:ref('K'),pixels:ref('Kpixels','application/x-ideogram-rgba8','64'),pixelIdentity:hash('Kidentity')},native:{source:ref('native-source'),literal:ref('Local letters','text/plain'),textVersion:hash('text-version'),renderVersion:hash('render-version'),dependencyHash:hash('native-dependencies')}}];
 const plan=planTextTreatment({id:'text-plan',inventory:{schemaVersion:1,kind:'text-treatment-inventory-1',documentId:'document',documentRevision:'7',grid:{width:4,height:4},imageState:ref('image-state'),layers,composition:null,semanticText:[]},choice:{kind:'baked-lettering',allowedHideNativeIds:['native'],duplicationAcknowledgement:'duplicates-reviewed',excludedSemanticIds:[],approvalId:'treatment-approved'},beforeSource:null,afterSource:null,prompt:{mode:'plain',bytes:ref('Exact prompt','text/plain'),projection:null},edit:null});
 return {plan,envelope:bindTextTreatmentEnvelope(plan,textTreatmentPlanRef(plan)),bytes:Buffer.from(canonical(plan))};
}
async function candidateFixture(t){
 const before=resources(),urlStart=display.created.length,releasedStart=display.released.length,displayReadStart=display.reads.length,{plan,envelope,bytes}=candidatePlan(),commands=[],reads=[],errors=[],opened=[],starts=[],responseOwners=[],gates=new Set(),pendingWork=new Set();let controller,override=null,readOverride=null,reviewOverride=null,latestReview,latestPreview;
 const gate=()=>{const value=deferred();gates.add(value);return value;};
 const track=promise=>{pendingWork.add(promise);void promise.then(()=>pendingWork.delete(promise),()=>pendingWork.delete(promise));return promise;};
 function ownEvents(events,type){
  const model=createOwnedModel('fixture-candidate-command-events',modelPayloadBytes(events),()=>structuredClone(events),'control'),row={type,released:false,pins:0};responseOwners.push(row);
  return {value:model.value,pin(){const unpin=model.pin();row.pins++;let live=true;return ()=>{assert(live,'Command result pin releases exactly once');live=false;row.pins--;unpin();};},release(){assert.equal(row.released,false,'Command result root releases exactly once');row.released=true;model.release();}};
 }
 const imageVersion={state:plan.inventory.imageState,semanticDigest:hash('document-digest'),compositeAssetId:'before'},document={id:'document',revision:'7',width:4,height:4,image:imageVersion};
 const native={id:'native',version:'1',kind:'text',name:'Native',visible:true,locked:false,layerToDocument:[1,0,0,1,1,2],opacity:0.75,mask:null,assetId:'native-asset',source:ref('native-source')};
 const candidates=['first','second'].map((id,index)=>({id,version:'1',documentId:'document',jobId:'job-'+index,attemptId:'attempt-'+index,requestId:'request-'+index,outputIndex:0,outputIdentity:'output-'+index,safety:'safe',state:'prepared',hidden:false,encodedAssetId:'encoded-'+index,preparedAssetId:'returned-'+index,warning:null}));
 const draft=newDraft(ref('Exact prompt','text/plain'));
 const editor={view:{ready:true,document,image:{schemaVersion:5,width:4,height:4,layers:[native],composition:null},selected:[]},draftOwner:{drafts:new Map()},sessionId:'session',session:{identity:()=> 'client',transport:()=>assert.fail('Unexpected unowned transport')},pinViewModels:()=>()=>{},beginFeedback(){},beginAdoption(...args){starts.push(args);},adoptionFailed(){},async open(id){opened.push(id);},
  command(){assert.fail('Candidate commands must return owned event roots');},
  async ownedCommand(body,target,newId){return ownEvents(await commandResult(body,target,newId),body.type);},
 };
 async function commandResult(body,target,newId){commands.push({body:structuredClone(body),target:structuredClone(target),newId});if(override)return override(body,target,newId);
   if(body.type==='ReviewCandidatePlacement'){
    // This is the owned server-response seam. Writer/raster controls verify the
    // immutable intent, comparison manifest and pixels; this suite exercises
    // the actual UI controllers, model ownership and explicit acceptance clock.
    const candidate=candidates.find(value=>value.id===body.candidateId),{type,...placement}=body,intent=ref('deferred-lettering-intent'),grid={width:4,height:4};
    latestReview={protocolVersion:1,kind:'candidate-placement-review-1',preparation:'deferred',reviewId:'placement-review-'+commands.length,reviewHash:hash('placement-review-'+commands.length),targetClientId:'client',expiresAt:new Date(Date.now()+60000).toISOString(),documentId:document.id,documentRevision:document.revision,source:imageVersion,placement,
     inputs:{kind:'candidate-adoption-inputs-1',mode:body.mode,identity:{candidateId:candidate.id,candidateVersion:candidate.version,documentId:document.id,jobId:candidate.jobId,attemptId:candidate.attemptId,requestId:candidate.requestId,outputIdentity:candidate.outputIdentity,preparedAssetId:candidate.preparedAssetId,preparedAssetVersion:'1',preparedAssetHash:asset(candidate.preparedAssetId).blob.hash,requestHash:hash('request'),jobVersion:'3',writerEpoch:'epoch'},plan:null,sourceCapture:null,outputMapping:null,coverage:null},width:4,height:4,
     lettering:{kind:'candidate-lettering-comparison-1',plan:body.textTreatment.plan,choice:body.textTreatment.choice,intent,intentHash:intent.hash,manifest:ref('deferred-lettering-manifest'),grid,candidateAloneAssetId:'lettering-alone',nativeOffAssetId:'lettering-off',nativeOnAssetId:'lettering-on'}};
    if(reviewOverride)reviewOverride(latestReview);
    return [{type:'CandidatePlacementReviewPrepared',payload:{reviewId:latestReview.reviewId,reviewHash:latestReview.reviewHash}}];
   }
   if(body.type==='PrepareCandidateAdoption'){latestPreview={previewId:'preview-'+commands.length,documentId:'document',documentRevision:'7',kind:'candidate-adoption',source:imageVersion,preparedAssetId:'prepared',after:{state:ref('after-state'),semanticDigest:hash('after'),compositeAssetId:'after'},plan:ref('placement-plan'),candidate:{candidateId:body.candidateId,mode:body.mode,placement:body.placement,newDocumentId:body.newDocumentId,coverage:null,outputMapping:null,textTreatment:{kind:'candidate-text-treatment-preview-1',...body.textTreatment,nativeOffAssetId:'native-off',nativeOnAssetId:'native-on'}}};latestPreview.candidate.textTreatment.kind='candidate-text-treatment-preview-1';return [{type:'ImageEditPreviewPrepared',payload:{preview:latestPreview}}];}
   if(body.type==='ReviewImageEdit'){latestReview={reviewId:'review-'+commands.length,reviewHash:hash('review-'+commands.length),preview:latestPreview};return [{type:'ImageEditReviewPrepared',payload:{reviewId:latestReview.reviewId,reviewHash:latestReview.reviewHash}}];}
   if(body.type==='AdoptCandidate')return [{type:'ImageEdited',payload:{}}];
   if(body.type==='AdoptReviewedCandidate')return latestReview.placement.placement==='new-document'?[{type:'DocumentCreated',payload:{document:{...document,id:latestReview.placement.newDocumentId}}}]:[{type:'ImageEdited',payload:{}}];
   throw Error('Unexpected mutation '+body.type);
 }
 const asset=id=>{const pixels=ref(id+'pixels','application/x-ideogram-rgba8','64'),manifest=ref(id+'manifest');return {id,version:'1',purpose:'image',availability:'available',safety:'safe',qualification:'canonical-raster',measuredMediaType:'image/png',blob:ref(id+'png','image/png'),dependencies:[manifest,pixels],raster:{schemaVersion:1,pipeline:'cp1-f64-triangle-area-v1/'+hash('pipeline'),width:4,height:4,pixels,pixelIdentity:hash(id+'identity'),manifest,role:'composite',sourceAssetIds:[],conversion:null}};};
 ownJSON(editor,async(path,init)=>{reads.push(path);if(readOverride){const overridden=await readOverride(path,init);if(overridden!==undefined)return overridden;}if(path.includes('text-treatment')){const offset=Number(new URL(path,'http://local').searchParams.get('offset')),part=bytes.subarray(offset,offset+32768);return {bytes:part.toString('base64'),byteLength:String(bytes.length),offset:String(offset),nextOffset:offset+part.length<bytes.length?String(offset+part.length):null};}if(path.startsWith('/api/v1/assets/'))return {protocolVersion:1,entityVersion:'1',projectionSchema:2,highWater:'7',projection:{kind:'inline',value:asset(path.split('/').at(-1))}};if(path.startsWith('/api/v1/jobs/')){const candidate=candidates.find(c=>path.includes('/'+c.jobId+'/'));return {items:[candidate],request:{endpoint:'ideogram/v4/generate',prompt:plan.prompt.bytes,seed:null,textTreatment:envelope},inert:false};}if(path.startsWith('/api/v1/image-edit-reviews/'))return latestReview;throw Error('Unexpected metadata '+path);});
 const host={updateComplete:Promise.resolve(),requestUpdate(){this.updateComplete=Promise.resolve();},querySelector(){return {focus(){}};}};
 const owns=()=>{const owner=editor.draftOwner,revision=editor.view.document.revision,session=editor.session;return ()=>owner===editor.draftOwner&&revision===editor.view.document.revision&&session===editor.session;};
 controller=new RequestEdits(host,editor,{draft:()=>draft,entryKey:()=> 'entry',hold:()=>()=>{},mutate:()=>assert.fail('Candidate review cannot edit request draft'),changed:()=>host.requestUpdate(),owns,error:error=>errors.push(error)});await controller.sync();controller.retainCandidates(candidates);
 const tree=(candidate=candidates[0])=>controller.renderCandidate(candidate,false,envelope);
 t.after(async()=>{display.fail(null);display.pending(null);display.failRelease(null);for(const gate of gates)gate.resolve();const work=await Promise.allSettled([...pendingWork]);await turn();const disposal=await Promise.allSettled([controller.dispose()]);await flush();assert(responseOwners.every(row=>row.released&&row.pins===0),'All command result roots and pins release after actual drain');assert.deepEqual(resources(),before);assert.deepEqual(display.released.slice(releasedStart).sort(),display.created.slice(urlStart).sort());for(const outcome of [...work,...disposal])assert.equal(outcome.status,'fulfilled',outcome.reason?.message);});
 return {controller,editor,host,candidates,plan,envelope,commands,reads,errors,opened,starts,responseOwners,gate,track,tree,owns,displayReads:()=>display.reads.slice(displayReadStart),urls:()=>display.created.slice(urlStart),setCommand:fn=>override=fn,setRead:fn=>readOverride=fn,setReview:fn=>reviewOverride=fn,review:()=>latestReview};
}
async function lettering(f,candidate=f.candidates[0]){
 const tree=()=>f.tree(candidate);await click(tree,'Review lettering choices for this output');assert(rendered(tree()).controls.some(c=>c.id==='candidate-text-load-'+candidate.id),'helper remains usable after initial sync');
 await click(tree,'candidate-text-load-'+candidate.id);await choose(tree,'candidate-text-action-'+candidate.id,'keep-both');await choose(tree,'candidate-text-duplicate-'+candidate.id,'',true);await click(tree,'candidate-text-confirm-'+candidate.id);assert.deepEqual(f.errors,[]);
}
async function inspectCandidate(f,candidate=f.candidates[0]){await click(()=>f.tree(candidate),'request-candidate-prepare-'+candidate.id);assert.deepEqual(f.errors,[]);}

test('candidate sync retains a live lettering helper, exact adjunct/newLayerId and actual native-off/on readiness',async t=>{
 const f=await candidateFixture(t);await lettering(f);await inspectCandidate(f);await click(f.tree,'request-candidate-place-first');assert.deepEqual(f.errors,[]);assert(f.responseOwners.every(row=>row.released&&row.pins===0),'Prepared review independently retains its model after command result release');
 const prepare=f.commands.find(row=>row.body.type==='PrepareCandidateAdoption').body;assert(prepare.textTreatment);assert.equal(prepare.textTreatment.choice.newLayerId,prepare.newLayerId);assert.deepEqual(prepare.textTreatment.plan,f.envelope);assert.deepEqual(f.commands.map(row=>row.body.type),['PrepareCandidateAdoption','ReviewImageEdit']);
 const review=f.controller.candidatePreviews.get('first');assert.equal(f.controller.candidateReady(review),false);const images=rendered(f.tree()).images.filter(row=>row.alt.startsWith('Current document')||row.alt.startsWith('Prepared full-grid')||row.alt.startsWith('Document after')||row.alt.startsWith('Prepared placement'));
 assert.equal(images.length,5);for(const image of images.slice(0,4)){image.load({currentTarget:{currentSrc:image.src,src:image.src,naturalWidth:4,naturalHeight:4}});assert.equal(f.controller.candidateReady(review),false);}const final=images[4];final.load({currentTarget:{currentSrc:final.src,src:final.src,naturalWidth:4,naturalHeight:4}});assert.equal(f.controller.candidateReady(review),true);
 assert(f.displayReads().includes('native-off'));assert(f.displayReads().includes('native-on'));await click(f.tree,'request-candidate-adopt-first');assert.equal(f.commands.at(-1).body.type,'AdoptCandidate');assert.equal(f.starts.length,1);
});

test('treatment-required candidate refuses missing active helper and unsupported encoded deferred boundaries',async t=>{
 const f=await candidateFixture(t);await inspectCandidate(f);const count=f.commands.length;
 await assert.rejects(f.controller.place(f.candidates[0],'current-document',f.owns()),/lettering|treatment/i);assert.equal(f.commands.length,count);
 await assert.rejects(f.controller.reviewPlacement(f.candidates[0],'current-document',f.owns()),/lettering|treatment/i);assert.equal(f.commands.length,count);
 await lettering(f);for(const placement of ['current-document','new-document'])await assert.rejects(f.controller.reviewPlacement(f.candidates[0],placement,f.owns(),false,true),/lettering|treatment|encoded/i);assert.equal(f.commands.length,count);
});

const deferredControl=(f,name)=>{const control=rendered(f.tree()).controls.find(value=>value.id==='request-candidate-'+name+'-first');assert(control,'Rendered deferred '+name);return control;};
const letteringImages=f=>rendered(f.tree()).images.filter(image=>['lettering-alone','lettering-off','lettering-on'].some(id=>image.src.includes('/'+id+'/')));
const loadImage=image=>{assert.equal(typeof image.load,'function');image.load({currentTarget:{src:image.src,currentSrc:image.src,naturalWidth:4,naturalHeight:4}});};
async function reviewLettering(f,placement='current-document'){
 await lettering(f);if(placement==='new-document'){await choose(f.tree,'candidate-text-action-first','new-document');await choose(f.tree,'candidate-text-copy-native','',true);await click(f.tree,'candidate-text-confirm-first');}await inspectCandidate(f);await click(f.tree,placement==='new-document'?'request-candidate-review-new-first':'request-candidate-review-current-first');
 assert.deepEqual(f.errors,[]);assert.deepEqual(f.commands.map(row=>row.body.type),['ReviewCandidatePlacement']);assert.equal(f.starts.length,0);
 assert.equal(f.controller.candidatePreviews.size,0,'A deferred review cannot masquerade as an eager prepared placement');
}
for(const placement of ['current-document','new-document'])test('native deferred '+placement+' binds exact treatment, releases reviewed displays and starts preparation only on Accept',async t=>{
 const f=await candidateFixture(t),original=structuredClone({document:f.editor.view.document,layer:f.editor.view.image.layers[0],plan:f.plan});await reviewLettering(f,placement);
 const command=f.commands[0].body,review=f.review();assert.deepEqual(command.textTreatment.plan,f.envelope);assert.equal(command.textTreatment.choice.newLayerId,command.newLayerId);assert.deepEqual(review.lettering.plan,command.textTreatment.plan);assert.deepEqual(review.lettering.choice,command.textTreatment.choice);assert.equal(review.lettering.intentHash,review.lettering.intent.hash);assert.equal(review.preparation,'deferred');
 if(placement==='new-document'){assert.equal(command.textTreatment.choice.action,'new-document');assert.equal(command.textTreatment.choice.nativeCopies.length,1);assert.equal(command.textTreatment.choice.nativeCopies[0].sourceLayerId,'native');assert.notEqual(command.textTreatment.choice.nativeCopies[0].newLayerId,command.newLayerId);assert.deepEqual(command.textTreatment.choice.nativeCopies[0].transform,[1,0,0,1,1,2]);}
 assert.equal(command.placement,placement);assert.equal(review.documentRevision,'7');assert.equal(review.inputs.identity.candidateVersion,'1');assert.equal(review.lettering.grid.width,4);assert.equal(review.lettering.grid.height,4);
 assert.deepEqual(f.displayReads().filter(id=>['lettering-alone','lettering-off','lettering-on'].includes(id)).sort(),['lettering-alone','lettering-off','lettering-on']);assert.equal(f.displayReads().includes('prepared'),false);
 const images=letteringImages(f);assert.equal(images.length,3);assert.equal(deferredControl(f,'confirm-lettering').disabled,true);assert.equal(deferredControl(f,'accept-prepare').disabled,true);
 for(const image of rendered(f.tree()).images.filter(image=>!images.some(value=>value.src===image.src)))loadImage(image);
 for(const image of images.slice(0,-1)){loadImage(image);assert.equal(deferredControl(f,'confirm-lettering').disabled,true);}
 loadImage(images.at(-1));await flush();assert.equal(deferredControl(f,'confirm-lettering').disabled,false);assert.equal(deferredControl(f,'accept-prepare').disabled,true,'Viewing images is separate from the explicit release confirmation');
 assert.deepEqual({document:f.editor.view.document,layer:f.editor.view.image.layers[0],plan:f.plan},original);assert.equal(f.starts.length,0);
 await click(f.tree,'request-candidate-confirm-lettering-first');assert.deepEqual(f.errors,[]);assert.equal(rendered(f.tree()).images.length,0,'Confirmation retires inspection and comparison image consumers');assert(f.urls().every(url=>display.released.includes(url)));assert.equal(f.controller.comparison.lifecycle.renderOwners,0);assert.equal(f.controller.comparison.lifecycle.states,0);assert.equal(f.controller.comparison.lifecycle.retired,0);assert.equal(deferredControl(f,'accept-prepare').disabled,false);assert.equal(f.starts.length,0);
 const reads=f.displayReads().length,gate=f.gate();f.setCommand(body=>{assert.equal(body.type,'AdoptReviewedCandidate');return gate.promise;});await click(f.tree,'request-candidate-accept-prepare-first');
 assert.deepEqual(f.commands.map(row=>row.body.type),['ReviewCandidatePlacement','AdoptReviewedCandidate']);assert.deepEqual(f.commands[1].body,{type:'AdoptReviewedCandidate',reviewId:review.reviewId,reviewHash:review.reviewHash,draft:null});assert.equal(f.displayReads().length,reads,'Accept cannot reacquire comparison displays');assert.equal(f.starts.length,1);assert.equal(f.starts[0][1],false,'No eager full-grid result was prepared');assert.equal(f.starts[0][2],123,'The actual acceptance event supplies the clock origin');
 assert.deepEqual(f.starts[0][0],{previewId:review.reviewId,candidateId:'first',jobId:'job-0',attemptId:'attempt-0',providerRequestId:'request-0',documentId:placement==='new-document'?command.newDocumentId:'document',...(placement==='new-document'?{}:{revision:'7'})});
 assert.deepEqual(f.commands[1].target,placement==='new-document'?null:original.document);assert.equal(f.commands[1].newId,placement==='new-document'?command.newDocumentId:undefined);
 gate.resolve(placement==='new-document'?[{type:'DocumentCreated',payload:{document:{...f.editor.view.document,id:command.newDocumentId}}}]:[{type:'ImageEdited',payload:{}}]);await turn();assert.deepEqual(f.errors,[]);assert.deepEqual(f.opened,placement==='new-document'?[command.newDocumentId]:[]);
 assert.deepEqual({document:f.editor.view.document,layer:f.editor.view.image.layers[0],plan:f.plan},original);
});

for(const fault of ['missing-lettering','wrong-plan','wrong-choice','wrong-placement-choice','wrong-intent-hash','wrong-grid'])test('native deferred review rejects '+fault+' without acquiring its comparisons or starting acceptance',async t=>{
 const f=await candidateFixture(t);await lettering(f);await inspectCandidate(f);f.setReview(review=>{
  if(fault==='missing-lettering')delete review.lettering;
  else if(fault==='wrong-plan')review.lettering.plan={...review.lettering.plan,plan:{...review.lettering.plan.plan,hash:hash('different-plan')}};
  else if(fault==='wrong-choice')review.lettering.choice={...review.lettering.choice,duplicationAcknowledgement:'changed'};
  else if(fault==='wrong-placement-choice')review.placement.textTreatment={...review.placement.textTreatment,choice:{...review.placement.textTreatment.choice,newLayerId:'different-layer'}};
  else if(fault==='wrong-intent-hash')review.lettering.intentHash=hash('different-intent');
  else review.lettering.grid={width:0,height:4};
 });
 await assert.rejects(f.controller.reviewPlacement(f.candidates[0],'current-document',f.owns()),/lettering|treatment|comparison|placement|intent/i);
 assert.deepEqual(f.commands.map(row=>row.body.type),['ReviewCandidatePlacement']);assert.equal(f.starts.length,0);assert.equal(f.controller.placementReviews.size,0);assert.equal(f.displayReads().some(id=>id.startsWith('lettering-')),false);
});

test('native deferred load and display errors revoke confirmation readiness until the actual image loads again',async t=>{
 const f=await candidateFixture(t);await reviewLettering(f);await loaded(f.tree);const image=letteringImages(f).at(-1);
 assert.equal(deferredControl(f,'confirm-lettering').disabled,false);assert.equal(typeof image.error,'function');image.error();await flush();assert.equal(deferredControl(f,'confirm-lettering').disabled,true);assert.equal(deferredControl(f,'accept-prepare').disabled,true);
 loadImage(image);await flush();assert.equal(deferredControl(f,'confirm-lettering').disabled,false);assert.equal(typeof image.displayError,'function');image.displayError();await flush();assert.equal(deferredControl(f,'confirm-lettering').disabled,true);
 loadImage(image);await flush();assert.equal(deferredControl(f,'confirm-lettering').disabled,false);assert.equal(f.starts.length,0);await click(f.tree,'request-candidate-confirm-lettering-first');assert.equal(deferredControl(f,'accept-prepare').disabled,false);
});

test('native deferred partial comparison failure releases every acquired sibling and cannot start adoption',async t=>{
 const f=await candidateFixture(t);await lettering(f);await inspectCandidate(f);const start=display.created.length;display.fail('lettering-on');
 await click(f.tree,'request-candidate-review-current-first');assert.match(f.errors.at(-1).message,/DISPLAY_TEST_FAILURE/);assert.equal(f.controller.placementReviews.size,0);assert.equal(f.starts.length,0);assert(display.created.slice(start).every(url=>display.released.includes(url)));assert.deepEqual(f.commands.map(row=>row.body.type),['ReviewCandidatePlacement']);display.fail(null);
});

for(const boundary of ['metadata-revision','comparison-owner','comparison-treatment'])test('native deferred '+boundary+' staleness cannot publish or accept the old review',async t=>{
 const f=await candidateFixture(t);await lettering(f);await inspectCandidate(f);const pending=f.gate(),start=display.created.length;
 if(boundary==='metadata-revision')f.setRead(async path=>{if(path.startsWith('/api/v1/image-edit-reviews/'))await pending.promise;});else display.pending(pending.promise);
 const work=f.track(f.controller.reviewPlacement(f.candidates[0],'current-document',f.owns()).catch(error=>{assert(isStaleRead(error),error?.message);}));await turn();
 if(boundary==='metadata-revision')f.editor.view.document.revision='8';
 else if(boundary==='comparison-owner')f.editor.draftOwner={drafts:new Map()};
 else{await choose(f.tree,'candidate-text-duplicate-first','',false);await choose(f.tree,'candidate-text-duplicate-first','',true);await click(f.tree,'candidate-text-confirm-first');}
 pending.resolve();display.pending(null);await work;await turn();assert.equal(f.controller.placementReviews.size,0);assert.equal(f.starts.length,0);assert.equal(f.commands.some(row=>row.body.type==='AdoptReviewedCandidate'),false);assert(display.created.slice(start).every(url=>display.released.includes(url)));
});

test('native deferred confirmation awaits rendered consumer retirement and a stale owner cannot complete it',async t=>{
 const f=await candidateFixture(t);await reviewLettering(f);await loaded(f.tree);const barrier=f.gate(),requestUpdate=f.host.requestUpdate;f.host.requestUpdate=function(){this.updateComplete=barrier.promise;};
 try{
  await click(f.tree,'request-candidate-confirm-lettering-first');assert.equal(rendered(f.tree()).images.length,0);assert.equal(deferredControl(f,'accept-prepare').disabled,true);assert.equal(f.starts.length,0);assert(f.urls().some(url=>!display.released.includes(url)),'Rendered consumers keep their display owners until the host commit barrier');
  f.editor.draftOwner={drafts:new Map()};barrier.resolve();await turn();const accept=rendered(f.tree()).controls.find(value=>value.id==='request-candidate-accept-prepare-first');assert(!accept||accept.disabled);assert.equal(f.starts.length,0);assert.equal(f.commands.some(row=>row.body.type==='AdoptReviewedCandidate'),false);
 }finally{f.host.requestUpdate=requestUpdate;barrier.resolve();f.host.requestUpdate();}
});

test('native deferred failed display cleanup blocks acceptance and explicit confirmation retries the retained cleanup',async t=>{
 const f=await candidateFixture(t);await reviewLettering(f);await loaded(f.tree);const target=letteringImages(f).at(-1).src;display.failRelease(target);
 await click(f.tree,'request-candidate-confirm-lettering-first');assert(f.errors.length>0);assert.equal(deferredControl(f,'accept-prepare').disabled,true);assert.equal(f.starts.length,0);assert.equal(display.released.includes(target),false);
 await click(f.tree,'request-candidate-confirm-lettering-first');assert.equal(display.released.includes(target),true);assert(f.urls().every(url=>display.released.includes(url)));assert.equal(deferredControl(f,'accept-prepare').disabled,false);assert.equal(f.starts.length,0);
});

test('changing confirmed lettering choices requires public reinspection before a fresh placement can be reviewed',async t=>{
 const f=await candidateFixture(t);await reviewLettering(f);await loaded(f.tree);await click(f.tree,'request-candidate-confirm-lettering-first');
 const previous=f.review(),oldURLs=[...f.urls()],controls=['request-candidate-place-first','request-candidate-new-document-first','request-candidate-review-current-first','request-candidate-review-new-first'];
 assert.equal(deferredControl(f,'accept-prepare').disabled,false,'The current confirmed review remains acceptable with its displays closed');
 const assertClosed=()=>{for(const id of controls){const control=rendered(f.tree()).controls.find(value=>value.id===id);assert(control,'Rendered '+id);assert.equal(control.disabled,true,id);}assert.match(rendered(f.tree()).text,/Inspect the frozen source and candidate again/);};assertClosed();
 await choose(f.tree,'candidate-text-action-first','hide-native-originals');await choose(f.tree,'candidate-text-hide-native','',true);await click(f.tree,'candidate-text-confirm-first');
 assertClosed();assert.equal(f.controller.placementReviews.size,0);assert.equal(f.starts.length,0);assert(oldURLs.every(url=>display.released.includes(url)));
 await assert.rejects(f.controller.place(f.candidates[0],'current-document',f.owns()),/Inspect the frozen source and candidate again/);
 await assert.rejects(f.controller.reviewPlacement(f.candidates[0],'current-document',f.owns()),/Inspect the frozen source and candidate again/);assert.equal(f.commands.length,1);
 await inspectCandidate(f);for(const id of controls)assert.equal(rendered(f.tree()).controls.find(value=>value.id===id).disabled,false,id);
 await click(f.tree,'request-candidate-review-current-first');assert.deepEqual(f.errors,[]);assert.deepEqual(f.commands.map(row=>row.body.type),['ReviewCandidatePlacement','ReviewCandidatePlacement']);
 assert.notEqual(f.review().reviewId,previous.reviewId);assert.notEqual(f.commands[1].body.newLayerId,f.commands[0].body.newLayerId);assert.equal(f.commands[1].body.textTreatment.choice.action,'hide-native-originals');assert.deepEqual(f.commands[1].body.textTreatment.choice.hideNativeIds,['native']);assert.deepEqual(f.commands[1].body.textTreatment.plan,f.envelope);
 const fresh=letteringImages(f);assert.equal(fresh.length,3);assert(fresh.every(image=>!oldURLs.includes(image.src)));assert.equal(deferredControl(f,'confirm-lettering').disabled,true);assert.equal(deferredControl(f,'accept-prepare').disabled,true);
 await loaded(f.tree);await click(f.tree,'request-candidate-confirm-lettering-first');assert.deepEqual(f.errors,[]);assert.equal(deferredControl(f,'accept-prepare').disabled,false);assert(f.urls().every(url=>display.released.includes(url)));assert.equal(f.controller.comparison.lifecycle.retired,0);assert.equal(f.starts.length,0);
});

test('a synchronous confirmation publication failure retains owners and permits an explicit cleanup retry',async t=>{
 const f=await candidateFixture(t);await reviewLettering(f);await loaded(f.tree);const preview=f.controller.placementReviews.get('first'),urls=f.urls().filter(url=>!display.released.includes(url)),requestUpdate=f.host.requestUpdate,failure=Error('LETTERING_PUBLICATION_TEST_FAILURE');let thrown=false;
 f.host.requestUpdate=function(){if(!thrown&&preview.letteringPhase==='closing'){thrown=true;throw failure;}return Reflect.apply(requestUpdate,this,[]);};
 try{
  await click(f.tree,'request-candidate-confirm-lettering-first');assert.equal(thrown,true);assert.equal(f.controller.placementReviews.get('first'),preview);assert.equal(preview.letteringPhase,'release-failed');assert(f.errors.includes(failure));assert(urls.every(url=>!display.released.includes(url)),'No image owner is released before the removal publication succeeds');assert(f.controller.comparison.lifecycle.retired>0);
  assert.equal(deferredControl(f,'accept-prepare').disabled,true);assert.equal(deferredControl(f,'confirm-lettering').disabled,false);assert.equal(f.starts.length,0);const reads=f.displayReads().length;
  await click(f.tree,'request-candidate-confirm-lettering-first');assert.equal(preview.letteringPhase,'confirmed');assert.equal(deferredControl(f,'accept-prepare').disabled,false);assert(urls.every(url=>display.released.includes(url)));assert.equal(f.controller.comparison.lifecycle.retired,0);assert.equal(f.displayReads().length,reads);assert.equal(f.errors.length,1);assert.equal(f.starts.length,0);assert.deepEqual(f.commands.map(row=>row.body.type),['ReviewCandidatePlacement']);
 }finally{f.host.requestUpdate=requestUpdate;f.host.requestUpdate();}
});

test('disposing an unconfirmed native deferred review releases its three comparisons and every input owner',async t=>{
 const f=await candidateFixture(t);await reviewLettering(f);assert.equal(letteringImages(f).length,3);assert(f.urls().some(url=>!display.released.includes(url)));
 await f.controller.dispose();await flush();assert(f.urls().every(url=>display.released.includes(url)));assert.equal(f.controller.placementReviews.size,0);assert.equal(f.controller.comparison.lifecycle.renderOwners,0);assert.equal(f.controller.comparison.lifecycle.retired,0);assert.equal(f.starts.length,0);assert.equal(f.commands.some(row=>row.body.type==='AdoptReviewedCandidate'),false);
});

test('only one candidate lettering helper can remain active across attempts and removed candidates release their plan',async t=>{
 const f=await candidateFixture(t);await lettering(f,f.candidates[0]);const first=f.controller.candidateTreatment;
 await lettering(f,f.candidates[1]);assert.equal(f.controller.activeTreatmentCandidate,'second');assert.equal(rendered(f.tree(f.candidates[0])).controls.some(c=>c.id==='candidate-text-load-first'),false);assert.equal(f.controller.candidateTreatment,first,'one shared helper serves all attempts');
 f.controller.retainCandidates([f.candidates[0]]);await flush();assert.equal(f.controller.activeTreatmentCandidate,'');assert.equal(f.controller.candidateTreatment.selection('second',{newLayerId:'fresh',placement:'current-document',mode:'full-candidate',preservation:'none'}),undefined);
});

test('partial native comparison acquisition failure releases every acquired sibling and never enables adoption',async t=>{
 const f=await candidateFixture(t);await lettering(f);await inspectCandidate(f);const start=display.created.length;display.fail('native-on');
 await click(f.tree,'request-candidate-place-first');assert.match(f.errors.at(-1).message,/DISPLAY_TEST_FAILURE/);assert.equal(f.controller.candidatePreviews.has('first'),false);assert.equal(f.starts.length,0);assert(display.created.slice(start).every(url=>display.released.includes(url)));display.fail(null);
});

test('native comparison results cannot publish after candidate version changes while display acquisition is pending',async t=>{
 const f=await candidateFixture(t);await lettering(f);await inspectCandidate(f);const pending=f.gate();display.pending(pending.promise);const start=display.created.length;
 await click(f.tree,'request-candidate-place-first');f.controller.retainCandidates([{...f.candidates[0],version:'2'},f.candidates[1]]);pending.resolve();display.pending(null);await turn();
 assert.equal(f.controller.candidatePreviews.has('first'),false);assert.equal(f.starts.length,0);assert(display.created.slice(start).every(url=>display.released.includes(url)));
});

test('changing lettering choices cancels a pending old placement while keeping its loaded plan usable for explicit reconfirmation',async t=>{
 const f=await candidateFixture(t);await lettering(f);await inspectCandidate(f);const pending=f.gate();display.pending(pending.promise);const start=display.created.length,work=f.track(f.controller.place(f.candidates[0],'current-document',f.owns()));await turn();
 assert(f.displayReads().includes('native-on'),'the old placement reached comparison acquisition');assert.deepEqual(f.responseOwners.map(row=>[row.type,row.released]),[['PrepareCandidateAdoption',false],['ReviewImageEdit',false]],'Both command event roots remain owned through pending comparison acquisition');await choose(f.tree,'candidate-text-duplicate-first','',false);await choose(f.tree,'candidate-text-duplicate-first','',true);await click(f.tree,'candidate-text-confirm-first');assert.deepEqual(f.errors,[]);
 pending.resolve();display.pending(null);await work;assert(f.responseOwners.every(row=>row.released&&row.pins===0),'Stale placement releases its command owners after acquisition drains');assert.equal(f.controller.candidatePreviews.has('first'),false);assert(display.created.slice(start).every(url=>display.released.includes(url)));
 await f.controller.place(f.candidates[0],'current-document',f.owns());assert(f.controller.candidatePreviews.has('first'),'the current, explicitly reconfirmed plan remains usable');assert.equal(f.commands.filter(row=>row.body.type==='PrepareCandidateAdoption').length,2);
});

test('helper release failure still clears candidate previews, inspection URLs and comparison state',async t=>{
 const f=await candidateFixture(t);await lettering(f);await inspectCandidate(f);await click(f.tree,'request-candidate-place-first');assert.deepEqual(f.errors,[]);const helper=f.controller.candidateTreatment,render=helper.render,reset=f.controller.comparison.reset,resetIds=[];
 helper.render=function(input){const result=render.call(this,input);if(input===null)throw Error('INJECTED_HELPER_RELEASE');return result;};f.controller.comparison.reset=function(id){resetIds.push(id);return reset.call(this,id);};
 try{assert.throws(()=>f.controller.releaseCandidate('first'),error=>error instanceof AggregateError&&error.errors.some(cause=>cause.message==='INJECTED_HELPER_RELEASE'));}
 finally{helper.render=render;f.controller.comparison.reset=reset;}
 await turn();assert.equal(f.controller.activeTreatmentCandidate,'');assert.equal(f.controller.candidatePreviews.has('first'),false);assert.equal(f.controller.inspections.has('first'),false);assert(resetIds.includes('first'));assert(f.urls().every(url=>display.released.includes(url)));assert.equal(helper.selection('first',{newLayerId:'fresh',placement:'current-document',mode:'full-candidate',preservation:'none'}),undefined);
});

for(const failure of ['dispose','drain'])test('controller disposal drains helper ownership and comparison URLs after injected '+failure+' failure',async t=>{
 const f=await candidateFixture(t);await lettering(f);await inspectCandidate(f);await click(f.tree,'request-candidate-place-first');assert.deepEqual(f.errors,[]);const helper=f.controller.candidateTreatment,dispose=helper.dispose,drain=helper.drain;let drained=0;
 helper.dispose=function(){dispose.call(this);if(failure==='dispose')throw Error('INJECTED_HELPER_DISPOSE');};helper.drain=async function(){drained++;await drain.call(this);if(failure==='drain')throw Error('INJECTED_HELPER_DRAIN');};
 try{await assert.rejects(f.controller.dispose(),error=>error instanceof AggregateError&&error.errors.some(cause=>cause.message==='INJECTED_HELPER_'+failure.toUpperCase()));}
 finally{helper.dispose=dispose;helper.drain=drain;}
 assert.equal(drained,1);assert.equal(f.controller.activeTreatmentCandidate,'');assert.equal(f.controller.candidatePreviews.size,0);assert.equal(f.controller.inspections.size,0);assert(f.urls().every(url=>display.released.includes(url)));
});

for(const tinyPages of [false,true])test('returned-caption controller '+(tinyPages?'rejects serial tiny-page amplification after nine reads':'accepts nine exact UTF8-boundary pages at its 256KiB limit'),async t=>{
 const before=resources(),base=JSON.stringify({high_level_description:'Scene',compositional_deconstruction:{background:'plain',elements:[{type:'text',bbox:[100,200,300,800],text:'Café 東京',desc:'Blue letters'}]}}),prefix=' '.repeat(32767-Buffer.byteLength(base.slice(0,base.indexOf('é')))),body=prefix+base,wire=body+' '.repeat(262144-Buffer.byteLength(body)),bytes=Buffer.from(wire),calls=[];
 // The maximum first page would bisect é, so the server-style page boundary
 // retreats one byte. The second page starts with the complete UTF-8 scalar.
 assert.equal(bytes[32767],0xc3);assert.equal(bytes[32768],0xa9);
 const editor={sessionId:'session',draftOwner:{},view:{ready:true,document:{id:'document',revision:'7',width:1000,height:500}}},host={updateComplete:Promise.resolve(),requestUpdate(){this.updateComplete=Promise.resolve();}};
 ownJSON(editor,async path=>{const offset=Number(new URL(path,'http://local').searchParams.get('offset'));let end=Math.min(bytes.length,offset+(tinyPages?1:32768));if(!tinyPages)while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;const part=bytes.subarray(offset,end);if(!tinyPages)new TextDecoder('utf-8',{fatal:true}).decode(part);calls.push(offset);return {bytes:part.toString('base64'),byteLength:String(bytes.length),offset:String(offset),nextOffset:offset+part.length<bytes.length?String(offset+part.length):null};});
 const controller=new ReturnedDescriptionEditing(host,editor,()=>assert.fail('Inspection cannot open a native draft')),target={jobId:'job',attemptId:'attempt',documentId:'document',documentRevision:'7',returnedPrompt:ref(wire,'text/plain')};
 try{if(tinyPages){await assert.rejects(controller.inspect(target,()=>true),/page count/);assert.equal(controller.current,undefined);assert.deepEqual(calls,[0,1,2,3,4,5,6,7,8]);}else{await controller.inspect(target,()=>true);assert.equal(controller.current.value.value.state,'available');assert.equal(calls.length,9);assert.equal(calls[1],32767);assert.equal(calls.at(-1),262143);}}
 finally{await controller.releaseDocument();await flush();assert.deepEqual(resources(),before);}
});


async function prepareTreatmentRequest(f){
 // Keep the existing owned response seam; only these tests need an acceptance
 // receipt and the frozen text-plan identity rendered by the actual Request UI.
 f.setReview((body,value)=>body.type==='AcceptRequestReview'?{acceptedReview:'review',requestId:'accepted-request'}:{...value,review:{...value.review,textTreatment:{planHash:hash('text-plan')}}});
 await overlay(f);await confirmTreatment(f);await click(()=>f.instance.render(),'prepare-request');assert.deepEqual(f.errors,[]);assert(f.instance.review);assert.equal(f.instance.accepted,false);
}

test('same-revision document confirmation preserves the actual prepared and accepted request and text treatment without saving',async t=>{
 const f=await requestFixture(t);await prepareTreatmentRequest(f);
 const request=()=>f.instance.render(),entry=f.instance.entry(),draft=entry.draft,generation=entry.generation,treatment=f.helper().review,intent=f.helper().intent(),review=f.instance.review,requestIntent=f.instance.intent,wire=canonical(draft),text=entry.text,savedDraft=f.editor.draftOwner.drafts.get(entry.id);
 for(const accepted of [false,true]){
  if(accepted){await click(request,'accept-request');assert.equal(f.instance.accepted,true);assert.equal(f.instance.acceptanceId,'accepted-request');}
  const saved=f.saved.length,reviews=f.reviews.length,commands=f.commands.length,acceptanceId=f.instance.acceptanceId;
  await click(request,'request-document');
  assert.equal(f.instance.entry(),entry);assert.equal(f.instance.entry().draft,draft);assert.equal(entry.generation,generation);assert.equal(f.instance.intent,requestIntent);assert.equal(f.helper().review,treatment);assert.equal(f.helper().intent(),intent);assert.equal(f.instance.review,review);assert.equal(f.instance.accepted,accepted);assert.equal(f.instance.acceptanceId,acceptanceId);
  assert.equal(f.saved.length,saved);assert.equal(f.editor.draftOwner.drafts.get(entry.id),savedDraft);assert.equal(f.reviews.length,reviews);assert.equal(f.commands.length,commands);assert.equal(entry.text,text);assert.equal(canonical(draft),wire);assert.equal(f.instance.message,'Request document revision confirmed.');assert.deepEqual(f.errors,[]);
 }
 assert.deepEqual(f.reviews.map(row=>row.type),['PrepareRequestReview','AcceptRequestReview']);
});

test('a changed document revision still replaces the Entry and invalidates prepared request and text treatment approval',async t=>{
 const f=await requestFixture(t);await prepareTreatmentRequest(f);const request=()=>f.instance.render();await click(request,'accept-request');assert.equal(f.instance.accepted,true);
 const entry=f.instance.entry(),draft=entry.draft,generation=entry.generation,intent=f.instance.intent,saved=f.saved.length,reviews=f.reviews.length,text=entry.text;
 f.editor.view.document.revision='8';assert.equal(f.helper().intent(),undefined,'The actual document revision already makes the old treatment stale');
 await click(request,'request-document');const next=f.instance.entry();
 assert.notEqual(next,entry);assert.notEqual(next.draft,draft);assert.equal(next.revision,'8');assert.equal(next.generation,generation+1);assert.equal(f.instance.intent,intent+1);assert.equal(f.saved.length,saved+1);assert.equal(f.saved.at(-1).revision,'8');assert.equal(next.text,text);assert.equal(f.instance.review,null);assert.equal(f.instance.accepted,false);assert.equal(f.helper().intent(),undefined);assert.equal(f.reviews.length,reviews);assert.equal(f.instance.message,'Request document revision confirmed.');
 await assert.rejects(f.instance.prepare(),/Prepare and confirm native and semantic/);assert.equal(f.saved.length,saved+1);assert.equal(f.reviews.length,reviews);assert.deepEqual(f.errors,[]);
});

for(const boundary of ['prompt refusal','stale owner','stale document','request release','entry release','disposed','late veto','IME'])test('same-revision document confirmation retains the '+boundary+' guard',async t=>{
 const f=await requestFixture(t),request=()=>f.instance.render(),template=request(),button=rendered(template).controls.find(row=>row.id==='request-document');assert(button);assert.equal(button.disabled,false);
 const entry=f.instance.entry(),draft=entry.draft,generation=entry.generation,saved=f.saved.length,message=f.instance.message,owner=f.editor.draftOwner,document=f.editor.view.document,input=f.instance.promptInput,e=event();
 try{
  if(boundary==='prompt refusal')input.refused=true;
  if(boundary==='stale owner')f.editor.draftOwner={drafts:new Map()};
  if(boundary==='stale document')f.editor.view.document={...document,id:'another-document'};
  if(boundary==='request release')f.instance.requestReleasing=true;
  if(boundary==='entry release')f.instance.entryReleasing=true;
  if(boundary==='disposed')f.instance.disposed=true;
  if(boundary==='IME')f.instance.composing=true;
  button.click(e);if(boundary==='late veto')e.defaultPrevented=true;await turn();
  assert.equal(f.instance.entry(),entry);assert.equal(entry.draft,draft);assert.equal(entry.generation,generation);assert.equal(f.saved.length,saved);assert.equal(f.instance.message,message);assert.deepEqual(f.reviews,[]);assert.deepEqual(f.commands,[]);assert.equal(f.instance.inspectMemory().entryTasks,0);assert.equal(f.instance.inspectMemory().entryHolds,0);
  if(boundary==='prompt refusal'){assert.equal(input.refused,true);assert.equal(f.errors.length,1);assert.match(f.errors[0].message,/full input remains/);}else assert.deepEqual(f.errors,[]);
 }finally{input.refused=false;f.editor.draftOwner=owner;f.editor.view.document=document;f.instance.requestReleasing=false;f.instance.entryReleasing=false;f.instance.disposed=false;f.instance.composing=false;await turn();}
});

for(const changed of [false,true])test('held actual text-treatment preparation '+(changed?'stays stale after a changed-revision confirmation':'survives same-revision document confirmation'),async t=>{
 const f=await requestFixture(t);await prepareTreatmentRequest(f);const request=()=>f.instance.render();await click(request,'accept-request');assert.equal(f.instance.accepted,true);
 const helper=f.helper(),entry=f.instance.entry(),draft=entry.draft,generation=entry.generation,review=f.instance.review,intent=helper.intent(),saved=f.saved.length,reviews=f.reviews.length,gate=deferred();let entered=false,pending;
 f.setRead(async path=>{const id=/\/assets\/([^/]+)\/raster$/.exec(path)?.[1];assert(id&&f.manifests.has(id),'Held preparation reads its actual captured source manifest');entered=true;await gate.promise;return f.manifests.get(id);});
 try{
  await click(f.tree,'text-treatment-prepare');pending=helper.task;assert(entered,'The actual preparation reached its manifest read before document confirmation');assert(pending);assert.equal(helper.busy,true);
  if(changed)f.editor.view.document.revision='8';
  await click(request,'request-document');
  if(changed){assert.notEqual(f.instance.entry(),entry);assert.notEqual(f.instance.entry().draft,draft);assert.equal(f.instance.entry().revision,'8');assert.equal(f.instance.entry().generation,generation+1);assert.equal(f.saved.length,saved+1);assert.equal(f.instance.review,null);assert.equal(f.instance.accepted,false);assert.equal(helper.intent(),undefined);}
  else{assert.equal(f.instance.entry(),entry);assert.equal(entry.draft,draft);assert.equal(entry.generation,generation);assert.equal(f.saved.length,saved);assert.equal(f.instance.review,review);assert.equal(f.instance.accepted,true);assert.equal(helper.intent(),intent);}
  gate.resolve();await pending;await helper.drain();
  if(changed){assert.equal(helper.review,null);assert.equal(helper.intent(),undefined);assert.equal(rendered(f.tree()).controls.some(row=>row.id==='text-treatment-confirm'),false);await assert.rejects(f.instance.prepare(),/Prepare and confirm native and semantic/);assert.equal(f.saved.length,saved+1);}
  else{assert(helper.review);assert.equal(helper.review.draft,draft);assert.equal(helper.review.current(),true);await loaded(f.tree);await click(f.tree,'text-treatment-confirm');assert(helper.intent());assert.equal(f.instance.entry(),entry);assert.equal(entry.generation,generation);assert.equal(f.saved.length,saved);assert.equal(f.instance.review,review);assert.equal(f.instance.accepted,true);}
  assert.equal(f.reviews.length,reviews);assert.deepEqual(f.errors,[]);
 }finally{gate.resolve();await Promise.allSettled(pending?[pending]:[]);try{await helper.drain();}finally{f.setRead(null);await turn();}}
});

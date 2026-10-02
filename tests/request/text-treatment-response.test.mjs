// Source-only scoped-response regressions. Reuses the text-treatment UI fixture
// boundaries; this is not a browser, decoder, or allocator qualification gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc} from 'vite';
import {displayControlURL} from '../display-module.mjs';
const root=process.env.REQUEST_RESPONSES_ROOT??'.',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}export const svg=html;');
const stable=Object.fromEntries(['request/core','protocol/json','protocol/request-edits'].map(name=>['../'+name+'.js',pathToFileURL(resolve('dist/local/src/'+name+'.js')).href]));
const {hash}=await import(stable['../request/core.js']),{canonical}=await import(stable['../protocol/json.js']);
const modelURL=data(`export const records=[];export function modelPayloadBytes(value){return JSON.stringify(value).length*4;}export function reserveModelBytes(owner,bytes){let refs=1,live=true;const row={owner,bytes,released:false};records.push(row);return {pin(){if(!refs)throw Error('released');refs++;let held=true;return ()=>{if(held){held=false;if(!--refs)row.released=true;}};},release(){if(live){live=false;if(!--refs)row.released=true;}}};}export function createOwnedModel(owner,bytes,create){const payload=reserveModelBytes(owner,bytes);try{return {value:create(),pin:()=>payload.pin(),release:()=>payload.release()};}catch(error){payload.release();throw error;}}`);
const {records,createOwnedModel}=await import(modelURL);
const displayURL=data(`import {readOwnedDisplayControl,DISPLAY_SOURCE_CONTROL_BYTES} from ${JSON.stringify(displayControlURL)};
 export async function withDisplaySource(transport,id,options,consume){const owner=await readOwnedDisplayControl('fixture-display-source',DISPLAY_SOURCE_CONTROL_BYTES,()=>readDisplaySource(transport,id,options));try{return await consume(owner.value);}finally{owner.release();}}
 export const created=[],released=[];export let failAt=0;export const fail=value=>failAt=value;export async function readDisplaySource(_transport,id){return {assetId:id};}export async function createDisplayPreviewURL(_transport,source,options){if(failAt&&created.length+1===failAt)throw Error('DISPLAY_TEST_FAILURE');if(options.signal.aborted||!options.owns())throw new DOMException('stale','AbortError');const url='blob:'+source.assetId+'/'+created.length;created.push(url);return url;}export function revokeDisplayPreviewURL(url){if(released.includes(url))throw Error('double release');released.push(url);}export function validateDisplayImage(){}`),display=await import(displayURL);
const promptURL=data('export class PromptReaderCleanupError extends Error{}');
async function moduleSource(path,imports={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const controls=await moduleSource('src/ui/adapters.ts'),{TextTreatmentEditing}=await import(await moduleSource(root+'/src/ui/text-treatment.ts',{...stable,lit,'./adapters.js':controls,'../observability/model-memory.js':modelURL,'../observability/prompt-memory.js':promptURL,'../observability/display-preview.js':displayURL,'./display-image.js':data('export const displayImage=value=>value;')}));
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();},turn=async()=>{await new Promise(resolve=>setTimeout(resolve,0));await new Promise(setImmediate);await flush();};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const ref=(label,mediaType='application/json',byteLength='32')=>({hash:hash(label),mediaType,byteLength});
function event(value='',checked=false){const currentTarget={value,checked,isConnected:true};return {currentTarget,composedPath:()=>[currentTarget],defaultPrevented:false};}
function handler(template,id,kind='click'){if(!template||typeof template!=='object')return;if(template.strings){const at=template.strings.findIndex((text,i)=>text.includes('id="'+id+'"')||text.endsWith('id=')&&template.values[i]===id);if(at>=0)for(let i=at;i<template.strings.length;i++){if(template.strings[i].endsWith('@'+kind+'='))return template.values[i];if(i>at&&template.strings[i].includes('</en-'))break;}}for(const value of Array.isArray(template)?template:template.values??[]){const found=handler(value,id,kind);if(found)return found;}}
// Plain enumerable getters remain structured-cloneable. A retained borrowed
// subtree throws after its command consumer has returned; independent clones do not.
function guarded(value,live){if(!value||typeof value!=='object')return value;const result=Array.isArray(value)?[]:{};for(const [key,child]of Object.entries(value)){const nested=guarded(child,live);Object.defineProperty(result,key,{enumerable:true,configurable:true,get(){assert(live(),'COMMAND_SCOPE_RELEASED');return nested;}});}return result;}

async function fixture(t){
 const modelStart=records.length,urlStart=display.created.length,releaseStart=display.released.length;display.fail(0);let draft,controller,template,serial=0,generation=0,commandHook=null;
 const image={state:ref('state'),semanticDigest:hash('state-digest'),compositeAssetId:'visible'},document={id:'document',revision:'7',width:4,height:4,image},layers=[{id:'bg',version:'1',kind:'image',name:'Background',visible:true,locked:false},{id:'text',version:'1',kind:'text',name:'Caption',visible:true,locked:false}];
 const commands=[],scopes=[],errors=[],holds=[],attachments=[],manifests=new Map();
 function capture(id,scope,ids){const pixels=ref(id+'-pixels','application/x-ideogram-rgba8','64'),manifest={width:4,height:4,pixels,plan:{kind:'request-source-capture-v1',capture:{schemaVersion:1,documentId:document.id,documentRevision:document.revision,image,scope,layerIds:ids}}},wire=canonical(manifest),metadata={hash:hash(wire),mediaType:'application/json',byteLength:String(Buffer.byteLength(wire))},asset={id,version:'1',blob:ref(id+'-png','image/png','48'),availability:'available',qualification:'canonical-raster',safety:'safe',raster:{manifest:metadata,pixels,role:'composite',width:4,height:4}};manifests.set(id,manifest);return {asset,source:{assetId:id,version:'1',blob:asset.blob,pixels,width:4,height:4,scope,documentRevision:'7',capture:metadata}};}
 const original=capture('original','selected-layers',['bg','text']).source;draft={operation:'transform-v45',prompt:{mode:'plain'},source:original,mask:null,preparedInputs:{original:true}};
 const semantic={key:'semantics-1',items:[],approvedExcludedIds:null};
 const editor={view:{ready:true,document,image:{width:4,height:4,layers}},draftOwner:{},sessionId:'session',session:{identity:()=> 'client',transport:()=>assert.fail('RAW_TRANSPORT_FORBIDDEN')},
  async command(){assert.fail('RAW_COMMAND_RESPONSE_FORBIDDEN');},async json(){assert.fail('RAW_JSON_RESPONSE_FORBIDDEN');},
  async withCommandEvents(body,consume,target){
   commands.push({body:structuredClone(body),target:structuredClone(target)});const ids=body.scope==='visible-document'?layers.filter(row=>row.visible).map(row=>row.id):body.layerIds;
   const events=commandHook?await commandHook(body,target,commands.length):[{type:'AssetRegistered',payload:{asset:capture('capture-'+(++serial),body.scope,ids).asset}}];
   const model=createOwnedModel('fixture-command-events',JSON.stringify(events).length*4,()=>structuredClone(events)),row={active:true,releases:0,value:null,result:undefined};row.value=guarded(model.value,()=>row.active);scopes.push(row);
   try{row.result=await consume(row.value);return row.result;}finally{row.active=false;row.releases++;model.release();}
  },
  async ownedJSON(path){const id=/\/assets\/([^/]+)\/raster$/.exec(path)?.[1];assert(manifests.has(id));return createOwnedModel('fixture-capture-manifest',JSON.stringify(manifests.get(id)).length*4,()=>structuredClone(manifests.get(id)));}
 };
 const host={updateComplete:Promise.resolve(),requestUpdate(){this.updateComplete=Promise.resolve().then(()=>{template=controller.render();});}};
 const owns=()=>{const prior=draft,version=generation,owner=editor.draftOwner,revision=editor.view.document.revision;return ()=>prior===draft&&version===generation&&owner===editor.draftOwner&&revision===editor.view.document.revision;};
 controller=new TextTreatmentEditing(host,editor,{draft:()=>draft,entryKey:()=> 'entry',hold(expected){assert.equal(expected,draft);const held={released:false};holds.push(held);return ()=>{assert.equal(held.released,false);held.released=true;};},owns,semantic:()=>semantic,attachAlternateSource(expected,source){assert.equal(expected,draft);attachments.push(source);draft={...structuredClone(draft),source:structuredClone(source),mask:null,preparedInputs:null};generation++;return draft;},openComposition(){assert.fail('Unexpected Composition navigation');},error:error=>errors.push(error)});
 template=controller.render();await flush();
 const choose=async(id,value,checked=false)=>{const callback=handler(template,id,'en-change');assert.equal(typeof callback,'function',id);callback(event(value,checked));await flush();};
 t.after(async()=>{controller.dispose();await flush();await controller.drain();await flush();assert(holds.every(row=>row.released),'All Entry holds drain');assert(scopes.every(row=>!row.active&&row.releases===1),'Every returned command scope releases exactly once');assert(records.slice(modelStart).every(row=>row.released),'Every controlled model owner releases');assert.deepEqual(display.released.slice(releaseStart).sort(),display.created.slice(urlStart).sort());display.fail(0);});
 await choose('text-treatment-kind','native-overlay');await choose('text-treatment-retain-text','',true);
 return {controller,editor,host,commands,scopes,errors,holds,attachments,original,manifests,capture,draft:()=>draft,setCommand(fn){commandHook=fn;},replaceDraft(){draft=structuredClone(draft);generation++;},async start(){const callback=handler(template,'text-treatment-prepare');assert.equal(typeof callback,'function');callback(event());await turn();return controller.task;},async prepare(){const task=await this.start();await task;await flush();},async confirm(){for(const picture of Object.values(controller.review.pictures))if(picture)picture.loaded=true;controller.confirm(draft);await flush();}};
}
const assertLive=owner=>{const release=owner.pin();release();},assertReleased=owner=>assert.throws(()=>owner.pin(),/released/);

test('baseline and alternate captures keep independent source owners through confirmation and the review Lit retirement',async t=>{
 const f=await fixture(t),before=structuredClone(f.draft());await f.prepare();assert.deepEqual(f.errors,[]);const review=f.controller.review;assert(review);assert.equal(review.captures.length,2);assert.equal(f.scopes.length,2);for(const scope of f.scopes){assert.equal(scope.releases,1);assert.throws(()=>scope.value[0],/COMMAND_SCOPE_RELEASED/);assertLive(scope.result);}assert.equal(review.baseline.assetId,'capture-1');assert.equal(review.afterSource.assetId,'capture-2');assert.deepEqual(f.draft(),before);await f.confirm();assert.equal(f.draft().source.assetId,'capture-2');assert.notEqual(f.draft().source,review.afterSource);assert.equal(f.controller.intent().baseline.assetId,'capture-1');
 const commit=deferred(),update=f.host.requestUpdate;f.host.requestUpdate=()=>{f.host.updateComplete=commit.promise;};try{f.controller.clearReview();await flush();assert.equal(f.controller.review,null);for(const owner of review.captures)assertLive(owner);commit.resolve();await f.controller.drain();for(const owner of review.captures)assertReleased(owner);assert.equal(f.draft().source.assetId,'capture-2');}finally{commit.resolve();f.host.requestUpdate=update;}
});

test('alternate capture failure releases the earlier baseline owner without publishing a review',async t=>{
 const f=await fixture(t),gate=deferred();f.setCommand(async(body,_target,index)=>{if(index===2)return gate.promise;return [{type:'AssetRegistered',payload:{asset:f.capture('baseline','visible-document',['bg','text']).asset}}];});let task;try{const started=f.start();await flush();await turn();task=f.controller.task;assert.equal(f.commands.length,2);assert.equal(f.scopes[0].releases,1);assertLive(f.scopes[0].result);gate.reject(Error('alternate capture failed'));await started;await task;await flush();assert.equal(f.controller.review,null);assert.equal(f.draft().source,f.original);assertReleased(f.scopes[0].result);assert.match(f.errors.at(-1).message,/alternate capture failed/);}finally{gate.resolve([]);await task;}
});

test('late stale capture releases its event scope before any source owner or review is retained',async t=>{
 const f=await fixture(t),gate=deferred();f.setCommand(()=>gate.promise);let task;try{const started=f.start();await flush();await turn();task=f.controller.task;assert.equal(f.commands.length,1);f.replaceDraft();gate.resolve([{type:'AssetRegistered',payload:{asset:f.capture('late','visible-document',['bg','text']).asset}}]);await started;await task;await flush();assert.equal(f.scopes[0].releases,1);assert.equal(f.scopes[0].result,undefined);assert.equal(f.controller.review,null);assert.equal(f.attachments.length,0);assert.deepEqual(f.errors,[]);}finally{gate.resolve([]);await task;}
});

test('invalid registered capture throws inside its scoped consumer and leaves the original draft intact',async t=>{
 const f=await fixture(t),before=structuredClone(f.draft());f.setCommand(async()=>{const asset=f.capture('invalid','visible-document',['bg','text']).asset;asset.safety='unknown';return [{type:'AssetRegistered',payload:{asset}}];});await f.prepare();assert.equal(f.scopes[0].releases,1);assert.equal(f.scopes[0].result,undefined);assert.equal(f.controller.review,null);assert.deepEqual(f.draft(),before);assert.match(f.errors.at(-1).message,/available canonical document raster/);
});

test('partial display failure releases both unpublished capture owners and the acquired preview',async t=>{
 const f=await fixture(t),first=display.created.length;display.fail(first+2);await f.prepare();assert.equal(f.scopes.length,2);assert(f.scopes.every(scope=>scope.releases===1));for(const scope of f.scopes)assertReleased(scope.result);assert.equal(f.controller.review,null);assert.equal(f.draft().source,f.original);assert.equal(display.created.length,first+1);assert(display.released.includes(display.created[first]));assert.match(f.errors.at(-1).message,/DISPLAY_TEST_FAILURE/);display.fail(0);
});

test('review form-pin refusal releases the acquired Entry hold, captures and all prepared previews',async t=>{
 const f=await fixture(t),firstHold=f.holds.length,firstURL=display.created.length,pin=f.controller.form.pin.bind(f.controller.form);let calls=0;
 t.mock.method(f.controller.form,'pin',()=>{if(++calls===2)throw Error('REVIEW_FORM_PIN_REFUSED');return pin();});
 await f.prepare();assert.equal(calls,2,'The action pin succeeds before the review pin refuses');assert.equal(f.controller.review,null);assert.equal(f.scopes.length,2);for(const scope of f.scopes)assertReleased(scope.result);assert.equal(f.holds.length-firstHold,2,'The action and unpublished review both acquired Entry holds');assert(f.holds.slice(firstHold).every(row=>row.released));assert.equal(display.created.length-firstURL,3);for(const url of display.created.slice(firstURL))assert(display.released.includes(url));assert.equal(f.draft().source,f.original);assert.match(f.errors.at(-1).message,/REVIEW_FORM_PIN_REFUSED/);
});

// Actual TextTreatment source with real model/ledger ownership. Lit and display
// are controlled commit/native boundaries; this does not qualify a browser decoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc} from 'vite';
import {allocationsURL,promptMemoryURL} from '../owned-preview-module.mjs';
const root=process.env.TEXT_TREATMENT_RETIREMENT_ROOT??'.',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}export const svg=html;');
const stable=Object.fromEntries(['request/core','protocol/json','protocol/request-edits'].map(name=>['../'+name+'.js',pathToFileURL(resolve('dist/local/src/'+name+'.js')).href]));
async function moduleSource(path,imports={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const modelURL=await moduleSource('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptMemoryURL});
const displayControlURL=await moduleSource('src/observability/display-control.ts',{'./model-memory.js':modelURL});
const {createOwnedModel,modelPayloadBytes}=await import(modelURL),{allocationLedger}=await import(allocationsURL);
const {hash}=await import(stable['../request/core.js']),{canonical}=await import(stable['../protocol/json.js']);
const displayURL=data(`import {readOwnedDisplayControl,DISPLAY_SOURCE_CONTROL_BYTES} from ${JSON.stringify(displayControlURL)};
 export async function withDisplaySource(transport,id,options,consume){const owner=await readOwnedDisplayControl('fixture-display-source',DISPLAY_SOURCE_CONTROL_BYTES,()=>readDisplaySource(transport,id,options));try{return await consume(owner.value);}finally{owner.release();}}
 export const live=new Set(),released=new Set();export let failURL=null;export const fail=url=>failURL=url;let serial=0;export async function readDisplaySource(_transport,id){return {assetId:id};}export async function createDisplayPreviewURL(_transport,source){const url='blob:'+source.assetId+'/'+(++serial);live.add(url);return url;}export function revokeDisplayPreviewURL(url){if(url===failURL)throw Error('REVOKE_REFUSED');if(!live.delete(url))throw Error('DOUBLE_REVOKE');released.add(url);}export function validateDisplayImage(){}`),display=await import(displayURL);
const controls=await moduleSource('src/ui/adapters.ts'),{TextTreatmentEditing}=await import(await moduleSource(root+'/src/ui/text-treatment.ts',{...stable,lit,'./adapters.js':controls,'../observability/model-memory.js':modelURL,'../observability/prompt-memory.js':promptMemoryURL,'../observability/display-preview.js':displayURL,'./display-image.js':data('export const displayImage=value=>value;')}));
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(a=>resolve=a);return {promise,resolve};};
const snapshot=()=>{const s=allocationLedger.snapshot();return Object.fromEntries(['cpuBytes','gpuBytes','previewCacheBytes','handles','activeRecords','promptBytes','unusedHandles'].map(key=>[key,s[key]]));};
const assertLive=owner=>{const release=owner.pin();release();},assertReleased=owner=>assert.throws(()=>owner.pin(),/MODEL_MEMORY_RELEASED/);
const own=(owner,value)=>createOwnedModel(owner,modelPayloadBytes(value),()=>structuredClone(value),'prompt');
const ref=(label,mediaType='application/json',byteLength='32')=>({hash:hash(label),mediaType,byteLength});
async function fixture(){
 const baseline=snapshot();let controller,template,serial=0,entry,generation=0;const errors=[],manifests=new Map(),sources=[];
 const image={state:ref('state'),semanticDigest:hash('state-digest'),compositeAssetId:'visible'},document={id:'document',revision:'7',width:4,height:4,image},layers=[{id:'bg',version:'1',kind:'image',name:'Background',visible:true,locked:false},{id:'text',version:'1',kind:'text',name:'Caption',visible:true,locked:false}];
 function capture(id,scope,ids){const pixels=ref(id+'-pixels','application/x-ideogram-rgba8','64'),manifest={width:4,height:4,pixels,plan:{kind:'request-source-capture-v1',capture:{schemaVersion:1,documentId:document.id,documentRevision:document.revision,image,scope,layerIds:ids}}},wire=canonical(manifest),metadata={hash:hash(wire),mediaType:'application/json',byteLength:String(Buffer.byteLength(wire))},asset={id,version:'1',blob:ref(id+'-png','image/png','48'),availability:'available',qualification:'canonical-raster',safety:'safe',raster:{manifest:metadata,pixels,role:'composite',width:4,height:4}};manifests.set(id,manifest);return {asset,source:{assetId:id,version:'1',blob:asset.blob,pixels,width:4,height:4,scope,documentRevision:'7',capture:metadata}};}
 entry=own('fixture-treatment-entry',{operation:'transform-v45',prompt:{mode:'plain'},source:capture('original','selected-layers',['bg','text']).source,mask:null});
 const editor={view:{ready:true,document,image:{width:4,height:4,layers}},draftOwner:{},sessionId:'session',session:{identity:()=> 'client',transport:()=>assert.fail('RAW_TRANSPORT_FORBIDDEN')},
  async withCommandEvents(body,consume){const ids=body.scope==='visible-document'?layers.map(row=>row.id):body.layerIds,events=own('fixture-treatment-command',[{type:'AssetRegistered',payload:{asset:capture('capture-'+(++serial),body.scope,ids).asset}}]);try{const source=await consume(events.value);sources.push(source);return source;}finally{events.release();}},
  async ownedJSON(path){const id=/\/assets\/([^/]+)\/raster$/.exec(path)?.[1];assert(manifests.has(id));return own('fixture-treatment-manifest',manifests.get(id));}
 };
 const host={updateComplete:Promise.resolve(),requestUpdate(){this.updateComplete=Promise.resolve().then(()=>{template=controller.render();});}};
 const update=host.requestUpdate,semantic={key:'semantics',items:[],approvedExcludedIds:null};
 controller=new TextTreatmentEditing(host,editor,{draft:()=>entry.value,entryKey:()=> 'entry',hold(expected){assert.equal(expected,entry.value);return entry.pin();},owns(){const expected=entry.value,version=generation;return ()=>expected===entry.value&&version===generation;},semantic:()=>semantic,attachAlternateSource(expected,source){assert.equal(expected,entry.value);const next=own('fixture-treatment-entry',{...entry.value,source});entry.release();entry=next;generation++;return entry.value;},openComposition(){assert.fail('Unexpected Composition navigation');},error:error=>errors.push(error)});
 try{template=controller.render();await flush();controller.kind='native-overlay';controller.retained.add('text');}catch(error){controller.dispose();await controller.drain();entry.release();throw error;}
 return {controller,host,errors,sources,baseline,entry:()=>entry,template:()=>template,update,
  async prepare(){await controller.prepare(entry.value,controller.current(entry.value),new AbortController().signal);await flush();assert.equal(controller.review.captures.length,2);for(const picture of Object.values(controller.review.pictures))if(picture)picture.loaded=true;controller.confirm(entry.value);await flush();assert(controller.intent());},
  async cleanup(){display.fail(null);host.requestUpdate=update;controller.dispose();await controller.drain();entry.release();await flush();assert.deepEqual(snapshot(),baseline);assert.equal(display.live.size,0);}
 };
}
function owners(f){const review=f.controller.review;return [f.controller.rendered,f.controller.form,review.context,...review.captures,review.approved,f.entry()];}

test('failed Lit retirement keeps review, Source joins, form and Entry pins until a successful teardown retry',async()=>{
 const f=await fixture();try{
  await f.prepare();const retained=owners(f),live=snapshot();f.entry().release();f.host.requestUpdate=function(){this.updateComplete=Promise.reject(Error('LIT_COMMIT_FAILED'));};
  f.controller.dispose();await assert.rejects(f.controller.drain(),/TEXT_TREATMENT_RELEASE_INCOMPLETE/);assert.equal(f.controller.review,null);assert.equal(f.controller.rendered,null);assert.equal(f.controller.form,null);for(const owner of retained)assertLive(owner);assert.deepEqual(snapshot(),live);
  for(let i=0;i<3;i++){await assert.rejects(f.controller.drain(),/TEXT_TREATMENT_RELEASE_INCOMPLETE/);assert.deepEqual(snapshot(),live);assert.equal(f.controller.retired.size,3);}
  f.host.requestUpdate=f.update;await f.controller.drain();for(const owner of retained)assertReleased(owner);assert.equal(f.controller.retired.size,0);assert.deepEqual(snapshot(),f.baseline);
 }finally{await f.cleanup();}
});

test('synchronous requestUpdate failure cannot lose a detached review or prevent form/context retirement',async()=>{
 const f=await fixture();try{
  await f.prepare();const retained=owners(f);f.entry().release();f.host.requestUpdate=()=>{throw Error('HOST_REQUEST_FAILED');};assert.doesNotThrow(()=>f.controller.clearReview());assert.doesNotThrow(()=>f.controller.dispose());
  await assert.rejects(f.controller.drain(),/TEXT_TREATMENT_RELEASE_INCOMPLETE/);for(const owner of retained)assertLive(owner);assert.equal(f.controller.retired.size,3);
  f.host.requestUpdate=f.update;await f.controller.drain();for(const owner of retained)assertReleased(owner);assert.deepEqual(snapshot(),f.baseline);
 }finally{await f.cleanup();}
});

test('teardown waits for the actual delayed host commit before returning any model booking',async()=>{
 const f=await fixture(),commit=deferred();let work;try{
  await f.prepare();const retained=owners(f),live=snapshot();f.entry().release();f.host.requestUpdate=function(){this.updateComplete=commit.promise.then(()=>f.controller.render());};f.controller.dispose();let settled=false;work=f.controller.drain().then(()=>{settled=true;});await flush();assert.equal(settled,false);for(const owner of retained)assertLive(owner);assert.deepEqual(snapshot(),live);
  commit.resolve();await work;for(const owner of retained)assertReleased(owner);assert.deepEqual(snapshot(),f.baseline);
 }finally{commit.resolve();await Promise.allSettled(work?[work]:[]);await f.cleanup();}
});

test('native revoke retry keeps only failed cleanup and does not repeat successful Entry or URL releases',async()=>{
 const f=await fixture();try{
  await f.prepare();const review=f.controller.review,urls=Object.values(review.pictures).map(picture=>picture.url),retained=owners(f);display.fail(urls[1]);f.entry().release();f.controller.dispose();await assert.rejects(f.controller.drain(),/TEXT_TREATMENT_RELEASE_INCOMPLETE/);
  for(const owner of retained)assertReleased(owner);assert.deepEqual([...display.live],[urls[1]]);assert.equal(f.controller.retired.size,1);assert.equal(f.controller.retired.values().next().value.cleanups.length,1);
  display.fail(null);await f.controller.drain();assert.equal(f.controller.retired.size,0);assert.equal(display.live.size,0);assert.deepEqual(snapshot(),f.baseline);
 }finally{await f.cleanup();}
});

test('synchronous action render failure releases its actual Entry/form pins through the tracked task',async()=>{
 const f=await fixture();try{
  const before=snapshot(),rendered=f.controller.rendered,form=f.controller.form;let requests=0,worked=false;f.host.requestUpdate=function(){requests++;throw Error('ACTION_RENDER_FAILED');};
  const target={isConnected:true},event={currentTarget:target,composedPath:()=>[target],defaultPrevented:false};f.controller.action(event,()=>{worked=true;});await new Promise(resolve=>setTimeout(resolve,0));await new Promise(setImmediate);await flush();await f.controller.drain();assert.equal(worked,false);assert(f.errors.some(error=>error.message==='ACTION_RENDER_FAILED'));assert(requests>=2,'Both initial and final action update failures are observed');assertLive(form);assertLive(rendered);assert.deepEqual(snapshot(),before);
  f.host.requestUpdate=f.update;f.entry().release();f.controller.dispose();await f.controller.drain();assert.deepEqual(snapshot(),f.baseline);
 }finally{await f.cleanup();}
});

for(const veto of [false,true])test('dispose drains '+(veto?'vetoed':'invalidated')+' queued action pins before completing',async()=>{
 const f=await fixture();let work;try{
  const entry=f.entry(),form=f.controller.form,target={isConnected:true},event={currentTarget:target,composedPath:()=>[target],defaultPrevented:veto};let worked=false,settled=false;
  f.controller.action(event,()=>{worked=true;});entry.release();f.controller.dispose();work=f.controller.drain().then(()=>{settled=true;});await flush();assert.equal(settled,false);assert.equal(f.controller.actions.size,1);assertLive(entry);assertLive(form);
  await work;assert.equal(worked,false);assert.equal(f.controller.actions.size,0);assertReleased(entry);assertReleased(form);assert.deepEqual(snapshot(),f.baseline);
 }finally{await Promise.allSettled(work?[work]:[]);await f.cleanup();}
});


test('unpublished prepare preserves its original failure and retries only the native release that failed',async()=>{
 const f=await fixture(),picture=f.controller.picture.bind(f.controller);const urls=[];let calls=0;try{
  const before=snapshot(),draft=f.entry().value,original=Error('THIRD_PREVIEW_FAILED');
  f.controller.picture=async(...args)=>{if(++calls===3)throw original;const value=await picture(...args);urls.push(value.url);if(calls===2)display.fail(value.url);return value;};
  await assert.rejects(f.controller.prepare(draft,f.controller.current(draft),new AbortController().signal),error=>error===original);
  assert.equal(f.controller.review,null);assert.equal(f.entry().value,draft);assert.equal(f.sources.length,2);for(const source of f.sources)assertReleased(source);assert.deepEqual(snapshot(),before);assert.equal(urls.length,2);assert(display.released.has(urls[0]));assert.deepEqual([...display.live],[urls[1]]);assert.equal(f.controller.retired.size,1);assert.equal(f.controller.retired.values().next().value.cleanups.length,1);
  await assert.rejects(f.controller.drain(),/TEXT_TREATMENT_RELEASE_INCOMPLETE/);assert.deepEqual(snapshot(),before);assert.deepEqual([...display.live],[urls[1]]);
  display.fail(null);await f.controller.drain();assert.equal(f.controller.retired.size,0);assert.equal(display.live.size,0);assert.deepEqual(snapshot(),before);assert.equal(f.entry().value,draft);
 }finally{f.controller.picture=picture;await f.cleanup();}
});

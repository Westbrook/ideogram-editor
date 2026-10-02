// Source-only response ownership regressions. The coordinated root owns execution.
// REQUEST_RESPONSES_ROOT selects the caller overlay; V45_INPUT_ROOT and
// UI_MODEL_ROOT select its existing memory dependencies after promotion.
import {allocationsURL as ledgerURL,promptMemoryURL as promptURL} from '../owned-preview-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc} from 'vite';

const root=process.env.REQUEST_RESPONSES_ROOT??'.',inputRoot=process.env.V45_INPUT_ROOT??'.',modelRoot=process.env.UI_MODEL_ROOT??'.';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64'),compiled=name=>pathToFileURL(resolve('dist/local/src/'+name+'.js')).href;
async function source(path,imports={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const modelURL=await source('src/observability/model-memory.ts',{'./allocations.js':ledgerURL,'./prompt-memory.js':promptURL});
const ownerURL=await source(modelRoot+'/src/ui/model-owner.ts',{'../observability/model-memory.js':modelURL,'../observability/prompt-memory.js':promptURL});
const memoryURL=await source(inputRoot+'/src/ui/request-v45-memory.ts',{'../observability/model-memory.js':modelURL,'../observability/prompt-memory.js':promptURL});
const lit=data('export const nothing=null;export const html=(strings,...values)=>({strings,values});');
const uiURL=await source(root+'/src/ui/request-v45-edit.ts',{'lit':lit,'./adapters.js':await source('src/ui/adapters.ts'),'./model-owner.js':ownerURL,'./request-v45-memory.js':memoryURL,'../observability/model-memory.js':modelURL,...Object.fromEntries(['request/core','request/v45-family-edit','request/v45-edit','protocol/v45-inputs','protocol/json'].map(name=>['../'+name+'.js',compiled(name)]))});
const {V45EditInputsEditing}=await import(uiURL),{allocationLedger,ALLOCATION_LIMITS}=await import(ledgerURL),{createOwnedModel,modelPayloadBytes,readOwnedJSON}=await import(modelURL);
const {newV45EditDraft}=await import(compiled('request/v45-family-edit')),{hash,bindRequestMask,requestMaskDependencies}=await import(compiled('request/core')),{createRequestRasterPlan,requestRasterGrid}=await import(compiled('request/raster-plan')),{canonical}=await import(compiled('protocol/json'));
const flush=async()=>{for(let n=0;n<100;n++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const ref=(label,mediaType='application/json',byteLength='32')=>({hash:hash(label),mediaType,byteLength});
const originalSource=(name,pixels=ref('shared-reference-pixels','application/x-ideogram-rgba8','128'))=>({assetId:name,version:'1',blob:ref(name+'-png','image/png'),pixels:structuredClone(pixels),width:8,height:4,scope:'single-layer',documentRevision:'7',capture:ref(name+'-capture')});
function draftFor(masked=false,references=3){
 const draft=newV45EditDraft(ref('Exact prompt','text/plain','12'),masked?'inpaint-v45':'transform-v45');draft.source=originalSource('source',ref('original-pixels','application/x-ideogram-rgba8','128'));draft.references=[originalSource('reference-a'),originalSource('reference-b'),originalSource('reference-a')].slice(0,references);
 if(masked){draft.fields.width='4';draft.fields.height='4';draft.mask={assetId:'mask',version:'1',blob:ref('white-mask','image/png'),pixels:ref('white-mask-pixels','application/x-ideogram-rgba8','128'),width:8,height:4,sourceHash:draft.source.pixels.hash,polarity:'white-edit',empty:false,full:false,fullAcknowledged:false,plan:ref('mask-authoring'),binding:bindRequestMask(draft.source)};draft.mask.requestPlan=createRequestRasterPlan({document:{width:8,height:4},crop:{x:0,y:0,width:8,height:4},padding:{left:0,top:0,right:0,bottom:0},requestGrid:{width:4,height:4},sourcePixels:draft.source.pixels,authoredMask:ref('hard','application/x-ideogram-r16le','64'),effectiveMask:ref('effective','application/x-ideogram-r16le','64'),dependenciesHash:requestMaskDependencies(draft.source,draft.mask),resolution:'already-contained',approvalId:'original-approval'});}
 return draft;
}
const raster=(name,width,height,pixels)=>({blob:ref(name+'-png','image/png'),pixels,manifest:ref(name+'-manifest'),pixelIdentity:hash(name+'-identity'),width,height});
function preparedBundle(draft){
 const masked=draft.operation==='inpaint-v45',grid=masked?requestRasterGrid(draft.mask.requestPlan):draft.source,pixels=masked?ref('transport-source-pixels','application/x-ideogram-rgba8',String(grid.width*grid.height*4)):draft.source.pixels;
 const mask=masked?{...raster('black-mask',grid.width,grid.height,ref('black-mask-pixels','application/x-ideogram-rgba8',String(grid.width*grid.height*4))),polarity:'black-edit',sourcePixels:pixels,editPixels:4,keepPixels:grid.width*grid.height-4}:null;
 const plan={kind:'v45-edit-inputs-1',endpoint:'ideogram/v4.5/edit',input:ref('input-plan'),assetBindings:{source:draft.source.assetId,mask:masked?draft.mask.assetId:null,references:draft.references.map(item=>item.assetId)},original:{source:structuredClone(draft.source),mask:masked?structuredClone(draft.mask):null},mask,requestPlan:masked?structuredClone(draft.mask.requestPlan):null,references:draft.references.map((original,index)=>({original:structuredClone(original),input:raster('reference-'+index,original.width,original.height,structuredClone(original.pixels))}))};
 const tiles=[{x:0,y:0,width:grid.width,height:grid.height,hash:pixels.hash}],pipeline='cp1-f64-triangle-area-v1',manifest={schemaVersion:1,pipeline,width:grid.width,height:grid.height,format:'straight-srgb-rgba8',layout:'row-major-tile-views-v1',tileSize:512,pixels,tiles,dependencies:[],plan},manifestText=canonical(manifest);
 const asset={id:'prepared-inputs',version:'1',purpose:'image',qualification:'canonical-raster',safety:'safe',availability:'available',measuredMediaType:'image/png',dependencies:[],blob:ref('prepared-source-png','image/png'),raster:{schemaVersion:1,pipeline,width:grid.width,height:grid.height,manifest:ref(manifestText,'application/json',String(Buffer.byteLength(manifestText))),pixels,pixelIdentity:hash(canonical({pipeline,width:grid.width,height:grid.height,tiles})),role:'composite',sourceAssetIds:[draft.source.assetId],conversion:null}};
 return {asset,manifest};
}
function capturedAsset(){const value=originalSource('captured-reference');return {id:value.assetId,version:value.version,qualification:'canonical-raster',blob:value.blob,raster:{width:value.width,height:value.height,pixels:value.pixels,manifest:value.capture,role:'composite'}};}
const receipt=asset=>[{type:'AssetRegistered',payload:{asset}}];
const nativeResponse=value=>{const text=JSON.stringify(value);return new Response(text,{headers:{'content-length':String(Buffer.byteLength(text))}});};
const sameUsage=(actual,expected)=>{for(const key of ['cpuBytes','promptBytes','activeRecords','handles'])assert.equal(actual[key],expected[key],key);};
const pressure=()=>allocationLedger.reserve({owner:'v45-response-test-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes});
function poisonEvents(events){for(const event of events){const asset=event.payload?.asset;if(asset){asset.id='released-command-asset';asset.blob.hash='released-command-blob';if(asset.raster){asset.raster.pixels.hash='released-command-pixels';asset.raster.manifest.hash='released-command-manifest';}}}}
function poisonManifest(value){value.pixels.hash='released-manifest-pixels';if(value.plan?.mask)value.plan.mask.blob.hash='released-manifest-mask';for(const ref of value.plan?.references??[])ref.input.blob.hash='released-manifest-reference';}

function fixture({masked=false,references=3}={}){
 const initial=draftFor(masked,references);let draftModel=createOwnedModel('v45-response-entry',modelPayloadBytes(initial),()=>initial,'prompt'),documentModel=createOwnedModel('v45-response-document',1024,()=>({id:'document',revision:'7',width:8,height:4}));
 let controller,bundle,commandHook,transportHook,beforeConsume=()=>{},afterConsume=()=>{},mutationHook=()=>{},activeScope=null,generation=0,documentPins=0,closed=false;
 const commands=[],scopes=[],reads=[],readOwners=[],errors=[],entryHolds=new Map(),draft=()=>draftModel.value;
 const editor={view:{document:documentModel.value,selected:['selected-a','selected-b']},draftOwner:{},sessionId:'session',session:{identity:()=> 'client',async transport(path,init){if(transportHook)return transportHook(path,init);assert.equal(path,'/api/v1/assets/prepared-inputs/raster');return nativeResponse(bundle.manifest);}},
  async command(){assert.fail('RAW_COMMAND_RESPONSE_FORBIDDEN');},async json(){assert.fail('RAW_JSON_RESPONSE_FORBIDDEN');},
  pinViewModels(value){assert.equal(value,editor.view.document);const unpin=documentModel.pin();documentPins++;let live=true;return ()=>{if(live){live=false;documentPins--;unpin();}};},
  async withCommandEvents(body,consume,target){
   commands.push({body:structuredClone(body),target:structuredClone(target)});let events;
   if(commandHook)events=await commandHook(body,target);else if(body.type==='PrepareRequestSource')events=receipt(capturedAsset());else{assert.equal(body.type,'PrepareV45EditInputs');bundle=preparedBundle(draft());events=receipt(bundle.asset);}
   const model=createOwnedModel('v45-response-events',modelPayloadBytes(events),()=>structuredClone(events)),row={value:model.value,model,active:true,releases:0,result:undefined};scopes.push(row);
   try{beforeConsume(row,body);activeScope=row;row.result=await consume(row.value);afterConsume(row,body);return row.result;}
   finally{activeScope=null;row.active=false;row.releases++;model.release();poisonEvents(row.value);}
  },
  async ownedJSON(path,owner,init,owns,maxBytes,kind){
   reads.push({path,maxBytes,kind});const model=await readOwnedJSON(editor.session.transport.bind(editor.session),path,{owner,init,owns,maxBytes,kind}),row={value:model.value,model,active:true,releases:0};readOwners.push(row);
   return {value:model.value,pin:()=>model.pin(),release(){row.releases++;if(!row.active)return;row.active=false;model.release();poisonManifest(row.value);}};
  }
 };
 const host={requestUpdate(){this.updateComplete=Promise.resolve().then(()=>{if(!closed)controller.render();});},updateComplete:Promise.resolve()};
 const owns=()=>{const expected=draft(),version=generation,owner=editor.draftOwner,session=editor.session,sessionId=editor.sessionId,documentId=editor.view.document.id,revision=editor.view.document.revision;return ()=>draft()===expected&&generation===version&&owner===editor.draftOwner&&session===editor.session&&sessionId===editor.sessionId&&documentId===editor.view.document.id&&revision===editor.view.document.revision;};
 const hold=expected=>{assert.equal(expected,draft());const unpin=draftModel.pin();entryHolds.set(expected,(entryHolds.get(expected)??0)+1);let live=true;return ()=>{if(!live)return;live=false;unpin();const count=entryHolds.get(expected)-1;if(count)entryHolds.set(expected,count);else entryHolds.delete(expected);};};
 const mutate=(expected,growth,change)=>{assert.equal(expected,draft());mutationHook(expected,growth,activeScope);const next=createOwnedModel('v45-response-entry',modelPayloadBytes(expected)+modelPayloadBytes(growth)+4096,()=>{const value=structuredClone(expected);change(value);return value;},'prompt');const old=draftModel;draftModel=next;old.release();generation++;host.requestUpdate();return next.value;};
 controller=new V45EditInputsEditing(host,editor,{draft,owns,hold,mutate,changed:()=>assert.fail('Unexpected duplicate draft mutation'),error:error=>errors.push(error),invalidateMapping(){}});controller.render();
 return {controller,editor,host,commands,scopes,reads,readOwners,errors,entryHolds,draft,documentPins:()=>documentPins,bundle:()=>bundle,stale(){generation++;},setCommand(fn){commandHook=fn;},setTransport(fn){transportHook=fn;},beforeConsume(fn){beforeConsume=fn;},afterConsume(fn){afterConsume=fn;},onMutation(fn){mutationHook=fn;},
  capture(scope='single-layer'){const current=draft();return controller.captureReference(current,scope,controller.owner(current));},prepare(){const current=draft();return controller.prepare(current,controller.owner(current));},
  async close(){closed=true;await controller.dispose();draftModel.release();documentModel.release();await flush();assert.equal(documentPins,0);assert.equal(entryHolds.size,0);assert(scopes.every(row=>!row.active&&row.releases===1));assert(readOwners.every(row=>!row.active&&row.releases===1));}
 };
}

test('reference capture clones its admitted source while the event root is live and keeps no event aliases',async()=>{
 const before=allocationLedger.snapshot(),f=fixture({references:0});try{
  const original=f.draft();let mutations=0;f.onMutation((expected,growth,scope)=>{mutations++;assert.equal(expected,original);assert(scope?.active);assert.equal(f.documentPins(),1);const asset=scope.value[0].payload.asset;assert.deepEqual(growth.blob,asset.blob);assert.notEqual(growth.blob,asset.blob);assert.notEqual(growth.pixels,asset.raster.pixels);assert.notEqual(growth.capture,asset.raster.manifest);});
  await f.capture('selected-layers');await flush();assert.equal(mutations,1);assert.deepEqual(f.commands[0],{body:{type:'PrepareRequestSource',scope:'selected-layers',layerIds:['selected-a','selected-b']},target:f.editor.view.document});assert.equal(f.scopes[0].active,false);assert.equal(f.scopes[0].value[0].payload.asset.id,'released-command-asset');assert.equal(f.draft().references[0].assetId,'captured-reference');assert.equal(f.draft().references[0].scope,'selected-layers');assert.equal(f.draft().references[0].blob.hash,capturedAsset().blob.hash);assert.deepEqual(original.references,[]);assert.equal(f.documentPins(),0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}sameUsage(allocationLedger.snapshot(),before);
});

for(const failure of ['missing-asset','mutation-refusal'])test('reference '+failure+' releases the scoped response, temporary clone and document pin',async()=>{
 const before=allocationLedger.snapshot(),f=fixture({references:0});try{const original=f.draft(),usage=allocationLedger.snapshot();if(failure==='missing-asset')f.setCommand(async()=>[]);else f.onMutation((_draft,_growth,scope)=>{assert.equal(scope.active,true);throw Error('reference admission refused');});await assert.rejects(f.capture(),failure==='missing-asset'?/Reference capture is unavailable/:/reference admission refused/);await flush();assert.equal(f.draft(),original);assert.equal(f.scopes[0].releases,1);assert.equal(f.documentPins(),0);sameUsage(allocationLedger.snapshot(),usage);}finally{await f.close();}sameUsage(allocationLedger.snapshot(),before);
});

test('a late capture scope is released after owner replacement without admitting a reference',async()=>{
 const before=allocationLedger.snapshot(),f=fixture({references:0}),gate=deferred();let work;try{const original=f.draft(),usage=allocationLedger.snapshot();f.setCommand(()=>gate.promise);work=f.capture();await flush();assert.equal(f.documentPins(),1);f.editor.draftOwner={};gate.resolve(receipt(capturedAsset()));await work;await flush();assert.equal(f.draft(),original);assert.deepEqual(original.references,[]);assert.equal(f.scopes[0].releases,1);assert.equal(f.documentPins(),0);sameUsage(allocationLedger.snapshot(),usage);}finally{gate.resolve(receipt(capturedAsset()));await work?.catch(()=>{});await f.close();}sameUsage(allocationLedger.snapshot(),before);
});

test('capture disposal waits for the late event scope and both actual document and Entry pins',async()=>{
 const before=allocationLedger.snapshot(),f=fixture({references:0}),gate=deferred();let work,closing;try{f.setCommand(()=>gate.promise);work=f.capture();await flush();let closed=false;closing=f.controller.dispose().then(()=>closed=true);await flush();assert.equal(closed,false);assert.equal(f.documentPins(),1);assert(f.entryHolds.size>0);gate.resolve(receipt(capturedAsset()));await work;await closing;assert.equal(closed,true);assert.equal(f.scopes[0].releases,1);assert.equal(f.documentPins(),0);assert.equal(f.entryHolds.size,0);assert.deepEqual(f.draft().references,[]);}finally{gate.resolve(receipt(capturedAsset()));await work?.catch(()=>{});await closing;await f.close();}sameUsage(allocationLedger.snapshot(),before);
});

for(const masked of [false,true])test('prepared '+(masked?'masked':'unmasked')+' asset outlives its event scope and manifest without lending their graphs to pending review',async()=>{
 const before=allocationLedger.snapshot(),f=fixture({masked}),gate=deferred(),started=deferred();let work;try{
  const original=f.draft();f.setTransport(async()=>{started.resolve();return gate.promise;});f.afterConsume(row=>{assert.equal(row.active,true);assert(row.result);assert.notEqual(row.result.value,row.value[0].payload.asset);assert.notEqual(row.result.value.blob,row.value[0].payload.asset.blob);});
  work=f.prepare();await started.promise;const scope=f.scopes[0],asset=scope.result;assert.equal(scope.releases,1);assert.equal(scope.active,false);assert.equal(scope.value[0].payload.asset.id,'released-command-asset');assert.equal(asset.value.id,'prepared-inputs');const unpin=asset.pin();unpin();assert.equal(f.controller.pending,null);assert.equal(f.reads[0].maxBytes,65536);assert.equal(f.reads[0].kind,'prompt');
  const expected=structuredClone(f.bundle());gate.resolve(nativeResponse(expected.manifest));await work;await flush();const pending=f.controller.pending;assert(pending);assert.equal(f.draft(),original);assert.equal(original.preparedInputs,null);assert.equal(pending.value.assetId,expected.asset.id);assert.deepEqual(pending.value.source.blob,expected.asset.blob);assert.notEqual(pending.value.source.blob,asset.value.blob);assert.deepEqual(pending.value.references.map(value=>value.blob),expected.manifest.plan.references.map(value=>value.input.blob));if(masked){assert.deepEqual(pending.value.mask.blob,expected.manifest.plan.mask.blob);assert.notEqual(pending.value.mask,f.readOwners[0].value.plan.mask);}assert.equal(f.readOwners[0].releases,1);assert.equal(f.readOwners[0].value.pixels.hash,'released-manifest-pixels');assert.throws(()=>asset.pin(),/MODEL_MEMORY_RELEASED/);assert.deepEqual(f.errors,[]);
 }finally{gate.resolve(nativeResponse(f.bundle()?.manifest??{}));await work?.catch(()=>{});await f.close();}sameUsage(allocationLedger.snapshot(),before);
});

test('asset-copy admission refusal occurs inside the scoped command response and releases it',async()=>{
 const before=allocationLedger.snapshot(),f=fixture();let block;try{const original=f.draft(),usage=allocationLedger.snapshot();f.beforeConsume(row=>{assert.equal(row.active,true);block=pressure();});await assert.rejects(f.prepare(),/PROMPT_MEMORY_BUDGET/);assert.equal(f.scopes[0].releases,1);assert.equal(f.scopes[0].result,undefined);assert.equal(f.reads.length,0);assert.equal(f.controller.pending,null);assert.equal(f.draft(),original);block.release();block=null;await flush();sameUsage(allocationLedger.snapshot(),usage);}finally{block?.release();await f.close();}sameUsage(allocationLedger.snapshot(),before);
});

test('a stale preparation command result releases its scope without retaining an asset or reading a manifest',async()=>{
 const before=allocationLedger.snapshot(),f=fixture(),gate=deferred();let work;try{const original=f.draft(),bundle=preparedBundle(original),usage=allocationLedger.snapshot();f.setCommand(()=>gate.promise);work=f.prepare();await flush();f.stale();gate.resolve(receipt(bundle.asset));await work;await flush();assert.equal(f.scopes[0].releases,1);assert.equal(f.scopes[0].result,undefined);assert.equal(f.reads.length,0);assert.equal(f.controller.pending,null);assert.equal(f.draft(),original);sameUsage(allocationLedger.snapshot(),usage);}finally{gate.resolve([]);await work?.catch(()=>{});await f.close();}sameUsage(allocationLedger.snapshot(),before);
});

for(const failure of ['transport','invalid-manifest','stale'])test('prepared manifest '+failure+' releases the copied asset and all returned metadata owners',async()=>{
 const before=allocationLedger.snapshot(),f=fixture(),gate=deferred(),started=deferred();let work;try{const original=f.draft(),usage=allocationLedger.snapshot();f.setTransport(async()=>{started.resolve();return gate.promise;});work=f.prepare();const rejected=assert.rejects(work,failure==='transport'?/manifest transport failed/:failure==='stale'?{name:'AbortError'}:/Prepared raster manifest identity changed/);await started.promise;const asset=f.scopes[0].result;assert.equal(f.scopes[0].releases,1);if(failure==='transport')gate.reject(Error('manifest transport failed'));else{const manifest=structuredClone(f.bundle().manifest);if(failure==='stale')f.stale();else manifest.tiles[0].hash=hash('changed-tile');gate.resolve(nativeResponse(manifest));}await rejected;await flush();assert.equal(f.draft(),original);assert.equal(f.controller.pending,null);assert.throws(()=>asset.pin(),/MODEL_MEMORY_RELEASED/);assert(f.readOwners.every(row=>row.releases===1));sameUsage(allocationLedger.snapshot(),usage);}finally{gate.resolve(nativeResponse(f.bundle()?.manifest??{}));await work?.catch(()=>{});await f.close();}sameUsage(allocationLedger.snapshot(),before);
});

test('preparation disposal retains the independent asset until native manifest cancellation completes',async()=>{
 const before=allocationLedger.snapshot(),f=fixture(),started=deferred(),cancelled=deferred(),cancel=deferred();let work,rejected,closing;try{f.setTransport(async()=>new Response(new ReadableStream({pull(){started.resolve();},cancel(){cancelled.resolve();return cancel.promise;}}),{headers:{'content-length':'100'}}));work=f.prepare();rejected=assert.rejects(work,{name:'AbortError'});await started.promise;const asset=f.scopes[0].result;assert.equal(f.scopes[0].releases,1);let closed=false;closing=f.controller.dispose().then(()=>closed=true);await cancelled.promise;await flush();assert.equal(closed,false);assert(f.entryHolds.size>0);const unpin=asset.pin();unpin();cancel.resolve();await rejected;await closing;assert.equal(closed,true);assert.throws(()=>asset.pin(),/MODEL_MEMORY_RELEASED/);assert.equal(f.entryHolds.size,0);assert.equal(f.controller.pending,null);}finally{cancel.resolve();await rejected;await closing;await f.close();}sameUsage(allocationLedger.snapshot(),before);
});

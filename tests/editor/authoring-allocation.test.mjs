// Staged source-only authoring coverage. This file has not been executed.
// Dependencies are real production modules; only Lit templates and display
// side effects are stand-ins. The corrected controller stays outside src/.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {draftStateDependencies} from '../draft-state-module.mjs';

const stagedRoot=process.env.AUTHORING_STAGED_ROOT??'',observationRoot=process.env.OBSERVABILITY_STAGED_ROOT??'.';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function source(path){if(path.startsWith('src/observability/'))try{return await readFile(observationRoot+'/'+path,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}return readFile(path,'utf8');}
async function module(path,replacements={}){
 let code=(await transformWithOxc(await source(path),path)).code;
 for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
 return data(code);
}
let diagnosticURL,compositionObserverURL;try{diagnosticURL=await module('src/observability/diagnostic-memory.ts');compositionObserverURL=await module('src/observability/composition-observations.ts',{'./diagnostic-memory.js':diagnosticURL});}catch(error){if(error.code!=='ENOENT')throw error;}
const allocationURL=await module('src/observability/allocations.ts',diagnosticURL?{'./diagnostic-memory.js':diagnosticURL,'./composition-observations.js':compositionObserverURL}:{});
const promptURL=await module('src/observability/prompt-memory.ts',{'./allocations.js':allocationURL});
const modelURL=await module('src/observability/model-memory.ts',{'./allocations.js':allocationURL,'./prompt-memory.js':promptURL});
const displayControlURL=await module('src/observability/display-control.ts',{'./model-memory.js':modelURL});
const controlURL=await module('src/state/control-memory.ts',{'../observability/allocations.js':allocationURL});
const {draftURL}=await draftStateDependencies(allocationURL,{root:'.',commandsRoot:'.',promptURL,memoryURL:modelURL,controlURL});
const {DraftPersistence}=await import(draftURL);
const coreURL=await module('src/raster/core.ts');
const mappingURL=await module('src/raster/mapping.ts',{'./core.js':coreURL});
const maskURL=await module('src/raster/mask.ts',{'./core.js':coreURL,'./mapping.js':mappingURL});
const adapterURL=await module('src/ui/adapters.ts'),shaURL=await module('src/protocol/sha256.ts');
const displayURL=data(`import {ownDisplayControl,readOwnedDisplayControl,DISPLAY_SOURCE_CONTROL_BYTES} from ${JSON.stringify(displayControlURL)};
 export const sourceFromAsset=value=>value;
 export const createDisplayPreviewURL=async(...args)=>globalThis.__stagedAuthoringDisplay.create(...args);
 export const readDisplaySource=async(_transport,id)=>({id});
 export async function withDisplaySource(transport,id,options,consume){const owner=await readOwnedDisplayControl('fixture-display-source',DISPLAY_SOURCE_CONTROL_BYTES,()=>readDisplaySource(transport,id,options));try{return await consume(owner.value);}finally{owner.release();}}
 export async function withAssetDisplaySource(asset,basis,consume){const owner=ownDisplayControl('fixture-display-source',DISPLAY_SOURCE_CONTROL_BYTES,()=>sourceFromAsset(asset,basis));try{return await consume(owner.value);}finally{owner.release();}}
 export const validateDisplayImage=()=>{};
 export const revokeDisplayPreviewURL=url=>globalThis.__stagedAuthoringDisplay.revoke(url);`);
const authoringURL=await module((stagedRoot?stagedRoot+'/':'')+'src/ui/authoring.ts',{
 'lit':data('export const nothing=null;export const html=(strings,...values)=>({strings,values});'),
 './display-image.js':data('export const displayImage=value=>value;'),
 '../observability/display-preview.js':displayURL,
 '../observability/allocations.js':allocationURL,'../observability/prompt-memory.js':promptURL,'../observability/model-memory.js':modelURL,
 '../state/control-memory.js':controlURL,'../raster/mapping.js':mappingURL,'../raster/mask.js':maskURL,
 './adapters.js':adapterURL,'../protocol/sha256.js':shaURL,
});
const {Authoring}=await import(authoringURL),{allocationLedger,ALLOCATION_LIMITS}=await import(allocationURL);
const {cloneOwnedModel,readOwnedJSON,modelPayloadBytes}=await import(modelURL);
const fixtures=new Set(),pressures=new Set(),draftOwners=new Set(),gates=new Set();
const deferred=()=>{let yes,no;const promise=new Promise((resolve,reject)=>{yes=resolve;no=reject;}),gate={promise,resolve(value){gates.delete(gate);yes(value);},reject(error){gates.delete(gate);no(error);}};gates.add(gate);return gate;};
const flush=async()=>{for(let i=0;i<48;i++)await Promise.resolve();};
// Import-time diagnostic owners remain realm-owned; compare exact action deltas.
const baseline=allocationLedger.snapshot();
const totals=()=>{const s=allocationLedger.snapshot();return {cpu:s.cpuBytes-baseline.cpuBytes,prompt:s.promptBytes-baseline.promptBytes,handles:s.handles-baseline.handles,records:s.activeRecords-baseline.activeRecords};};
const asset=id=>({id,raster:{width:20,height:20}});
const registered=id=>[{type:'AssetRegistered',payload:{asset:asset(id)}}];
const rectangle=(x=1)=>({kind:'rectangle',x,y:2,width:4,height:5});
const nativeEvent=(value='')=>{const target={value,isConnected:true,setPointerCapture(){}};return {currentTarget:target,target,composedPath:()=>[target],detail:{value,isComposing:false},defaultPrevented:false,pointerId:7,button:0,clientX:100,clientY:150,altKey:false,timeStamp:12,isTrusted:true,preventDefault(){this.defaultPrevented=true;}};};
function field(template,label){
 if(!template||typeof template!=='object')return null;
 if(template.strings?.[0].includes('<en-number-field label=')&&template.values[0]===label)return template;
 for(const child of Array.isArray(template)?template:template.values??[]){const result=field(child,label);if(result)return result;}
 return null;
}
function timers(t){
 const pending=new Map();let serial=0;
 t.mock.method(globalThis,'setTimeout',callback=>{const id=++serial;pending.set(id,callback);return id;});
 t.mock.method(globalThis,'clearTimeout',id=>{pending.delete(id);});
 return {pending,async tick(){for(const [id,callback]of [...pending]){pending.delete(id);callback();}await flush();}};
}
function pressure(t,remaining=0){
 const bytes=ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-allocationLedger.snapshot().cpuBytes-remaining;
 assert.ok(bytes>=0);const lease=allocationLedger.reserve({owner:'authoring-test-pressure',kind:'control',cpuBytes:bytes});
 pressures.add(lease);return lease;
}
function fixture(t,afterRender){
 const document={id:'document',revision:'1',width:20,height:20,image:{compositeAssetId:'accepted-composite'}};
 const layer={id:'layer',version:'1',name:'Layer',assetId:'source-image',layerToDocument:[1,0,0,1,0,0],opacity:1,visible:true,locked:false,mask:null};
 const saved=[],commands=[],responses=[],failures=[],displays=[],revoked=[],patches=[],zooms=[];let changed=0,drawn=0,reviewOwner=null,sequence=0;
 let command=async body=>body.type==='PrepareMask'?registered('mask-'+(++sequence)):body.type==='ComposeRaster'?registered('composite-'+(++sequence)):body.type==='ApproveRaster'?registered('approved-mask'):[];
 let inspectResponse=()=>{},display=async()=>{};
 let response=async()=>({plan:{statistics:{support:{x:0,y:0,width:20,height:20},hardPixels:400,effectivePixels:400}}});
 const editor={sessionId:'session',view:{ready:true,busy:false,document,image:{layers:[layer]},selected:['layer'],review:null},ui:{drafts:[]},draftOwner:{drafts:new Map()},
  changeDraft(id,kind,text,target){saved.push({id,kind,text,target});this.draftOwner.drafts.set(id,{generation:String(saved.length),savedGeneration:String(saved.length)});},
  fail(error){failures.push(error);},async run(_label,work){try{await work();}catch(error){failures.push(error);}},
  async flushDrafts(){},async clearDraft(id){this.draftOwner.drafts.delete(id);},
  async command(){throw Error('RAW_COMMAND_RESPONSE_FORBIDDEN');},
  async withCommandEvents(body,consume,owner){commands.push({body,owner});const retained=cloneOwnedModel('authoring-command-response',await command(body,owner)),row={type:body.type,value:retained.value,active:true};responses.push(row);try{inspectResponse(row);return await consume(retained.value);}finally{row.active=false;retained.release();/* Poison runner-retained fixture graph after release to expose escaped product aliases. */for(const event of row.value)if(event.type==='AssetRegistered')Object.assign(event.payload.asset,{id:'released-event',raster:{width:-1,height:-1}});}},
  patch(patch){patches.push(patch);if(Object.hasOwn(patch,'review')&&patch.review===null){reviewOwner?.release();reviewOwner=null;}Object.assign(this.view,patch);},
  async importImage(){const value={kind:'image',asset:asset('imported-mask'),review:{reviewId:'review-id',reviewHash:'sha256:'+'a'.repeat(64)},target:document,retainedEvidence:'must not be borrowed'};reviewOwner=cloneOwnedModel('authoring-editor-review',value);this.view.review=reviewOwner.value;},
  async ownedJSON(path,owner,init,owns,maxBytes){return readOwnedJSON(this.session.transport,path,{owner,init,owns,maxBytes});},
  async draftText(){throw Error('Unexpected draft read');},
  session:{async transport(path,init){const value=await response(path,init),text=JSON.stringify(value);return new Response(text,{headers:{'content-length':String(new TextEncoder().encode(text).byteLength)}});}},
 };
 const previous=globalThis.__stagedAuthoringDisplay;
 globalThis.__stagedAuthoringDisplay={create:async(_transport,source,options)=>{if(options.signal?.aborted||options.owns&&!options.owns())throw new DOMException('stale','AbortError');return 'blob:authoring-'+source.id;},revoke:url=>revoked.push(url)};
 const owner=new Authoring(editor,()=>{changed++;},()=>{drawn++;},async value=>{displays.push(value);await display(value);},afterRender,(point,out)=>zooms.push({point:[...point],out}));
 fixtures.add(async()=>{try{await owner.dispose();}finally{reviewOwner?.release();if(previous===undefined)delete globalThis.__stagedAuthoringDisplay;else globalThis.__stagedAuthoringDisplay=previous;}});
 return {owner,editor,saved,commands,responses,failures,displays,revoked,patches,zooms,setResponseInspection(value){inspectResponse=value;},setDisplay(value){display=value;},setCommand(value){command=value;},setResponse(value){response=value;},counts:()=>({changed,drawn}),reviewOwner:()=>reviewOwner};
}
function accepted(f){
 const o=f.owner;return {draft:o.draft,plan:o.draft?.plan,selection:o.selection,form:o.form,preview:o.preview,generation:o.generation,saved:f.saved.length,deep:structuredClone({draft:o.draft,selection:o.selection,form:o.form})};
}
function unchanged(f,before){
 const o=f.owner;for(const key of ['draft','selection','form','preview','generation'])assert.equal(o[key],before[key],key+' identity is retained');
 assert.equal(o.draft?.plan,before.plan);assert.equal(f.saved.length,before.saved);
 assert.deepEqual({draft:o.draft,selection:o.selection,form:o.form},before.deep);
}
test.afterEach(async()=>{
 // Node afterEach runs before per-test after hooks. Resolve every test barrier,
 // remove synthetic pressure, then await actual controller and draft drains.
 for(const gate of [...gates])gate.resolve();for(const pressure of pressures)pressure.release();pressures.clear();
 const errors=[];for(const close of [...fixtures].reverse())try{await close();}catch(error){errors.push(error);}fixtures.clear();
 for(const owner of draftOwners)try{await owner.dispose();}catch(error){errors.push(error);}draftOwners.clear();
 if(errors.length)throw new AggregateError(errors,'AUTHORING_FIXTURE_CLEANUP');
 assert.deepEqual(totals(),{cpu:0,prompt:0,handles:0,records:0});
});

test('selection growth admission refuses before cloning and retains the accepted draft and preview',async t=>{
 const f=fixture(t);f.owner.selectShape(rectangle());f.owner.useSelection();await f.owner.prepare();f.owner.combine='add';
 const before=accepted(f),retained=totals(),occupied=pressure(t);let clones=0;const clone=globalThis.structuredClone;
 t.mock.method(globalThis,'structuredClone',(...args)=>{clones++;return clone(...args);});
 assert.throws(()=>f.owner.selectShape(rectangle(7)),/ALLOCATION_BUDGET/);assert.equal(clones,0);
 unchanged(f,before);occupied.release();assert.deepEqual(totals(),retained);
});

test('selection geometry updates its numeric controls atomically with selection admission',t=>{
 const f=fixture(t),shape={kind:'ellipse',x:7,y:8,width:9,height:10};f.owner.selectShape(shape);
 for(const [label,value]of [['Selection X','7'],['Selection Y','8'],['Selection width','9'],['Selection height','10']])assert.equal(field(f.owner.render(),label).values[1],value);
 assert.deepEqual(f.owner.selection,[{kind:'shape',shape,mode:'replace'}]);f.owner.useSelection();
 const before=accepted(f),retained=totals(),next={kind:'shape',shape:rectangle(12),mode:'replace'},occupied=pressure(t,modelPayloadBytes([next]));
 // The new geometry fits, but its matching form cannot be admitted. Neither
 // accepted geometry nor any of the four corresponding controls may advance.
 assert.throws(()=>f.owner.selectShape(next.shape),/ALLOCATION_BUDGET/);unchanged(f,before);
 occupied.release();assert.deepEqual(totals(),retained);
});

test('mask append admission preserves the complete old plan, generation, saved text and preview',async t=>{
 const f=fixture(t);f.owner.push({kind:'fill'});await f.owner.prepare();const before=accepted(f),retained=totals(),occupied=pressure(t);
 assert.throws(()=>f.owner.push({kind:'stroke',points:[[1,1],[2,2]],size:3,hardness:1,mode:'subtract'}),/ALLOCATION_BUDGET/);
 unchanged(f,before);occupied.release();assert.deepEqual(totals(),retained);
});

test('numeric form admission reports refusal and retains the old form, draft and preview',async t=>{
 const f=fixture(t);f.owner.push({kind:'fill'});await f.owner.prepare();f.owner.width='15';
 const before=accepted(f),retained=totals(),handler=field(f.owner.render(),'Selection width').values.at(-1),occupied=pressure(t);
 const event=nativeEvent('160');handler(event);await flush();unchanged(f,before);assert.equal(event.currentTarget.value,before.form.width);
 assert.equal(f.failures.length,1);assert.match(f.failures[0].message,/ALLOCATION_BUDGET/);
 occupied.release();assert.deepEqual(totals(),retained);
});

test('feather form admission followed by draft-copy refusal rolls back the entire form and draft transaction',async t=>{
 const f=fixture(t);f.owner.push({kind:'fill'});await f.owner.prepare();
 const before=accepted(f),retained=totals(),formBytes=modelPayloadBytes(f.owner.form)-f.owner.radius.length*2+2;
 const handler=field(f.owner.render(),'Feather radius (document px)').values.at(-1),occupied=pressure(t,formBytes);
 const event=nativeEvent('2');handler(event);await flush();unchanged(f,before);assert.equal(event.currentTarget.value,before.form.radius);
 assert.equal(f.failures.length,1);assert.match(f.failures[0].message,/ALLOCATION_BUDGET/);
 occupied.release();assert.deepEqual(totals(),retained);
});

test('a fresh-mask candidate admitted before validation refusal cannot replace the accepted mask',async t=>{
 const f=fixture(t);f.owner.push({kind:'fill'});await f.owner.prepare();
 const candidate=f.owner.freshDraft(true),allowance=modelPayloadBytes(candidate.value);candidate.payload.release();
 const before=accepted(f),retained=totals(),occupied=pressure(t,allowance);
 assert.throws(()=>f.owner.startFresh(),/ALLOCATION_BUDGET/);unchanged(f,before);
 occupied.release();assert.deepEqual(totals(),retained);
});

test('polygon parse refuses before split or numeric-array growth and preserves all prior state',t=>{
 const f=fixture(t);f.owner.selectShape(rectangle());f.owner.useSelection();f.owner.shape='polygon';f.owner.polygon='0,0 10,0 10,10';
 const before=accepted(f),retained=totals(),occupied=pressure(t);let splits=0;const split=String.prototype.split;
 t.mock.method(String.prototype,'split',function(...args){if(String(this)===f.owner.polygon)splits++;return split.apply(this,args);});
 assert.throws(()=>f.owner.numericShape(),/ALLOCATION_BUDGET/);assert.equal(splits,0);unchanged(f,before);
 occupied.release();assert.deepEqual(totals(),retained);
});

test('a stroke rejected after its admitted prefix never appends that prefix to the mask draft',async t=>{
 const schedule=timers(t),f=fixture(t);f.owner.push({kind:'fill'});f.owner.choose('Mask');const before=accepted(f),retained=totals();
 f.owner.pointerDown(nativeEvent(),[0,0]);
 for(let i=0;i<4000&&!f.owner.gesture.rejected;i++)f.owner.pointerMove(nativeEvent(),[32767,32767]);
 assert.equal(f.owner.gesture.rejected,true);assert.deepEqual(f.owner.gesture.points,[]);
 assert.match(f.failures.at(-1).message,/complete stroke or selection|local command size/);
 unchanged(f,before);f.owner.pointerUp(nativeEvent(),[1,1]);await schedule.tick();
 unchanged(f,before);assert.equal(f.owner.lifecycle.gestures,0);assert.equal(f.owner.lifecycle.pendingPointer,0);assert.deepEqual(totals(),retained);
});

test('mask import retains its own reduced review before the editor clears and releases its review',async t=>{
 const f=fixture(t);await f.owner.importPNG(new File(['png'],'mask.png',{type:'image/png'}));
 assert.equal(f.editor.view.review,null);assert.equal(f.reviewOwner(),null);assert.equal(f.patches.some(value=>value.review===null),true);
 const imported=f.owner.pendingImport,model=f.owner.models.get('import');assert.equal(model.value,imported);
 assert.deepEqual(imported,{asset:asset('imported-mask'),review:{reviewId:'review-id',reviewHash:'sha256:'+'a'.repeat(64)},target:{id:'document',revision:'1'}});
 assert.ok(allocationLedger.snapshot().byKind.control.cpuBytes>=modelPayloadBytes(imported));
 assert.equal(Object.hasOwn(imported,'retainedEvidence'),false);assert.equal(f.owner.importName,'mask.png');
 await f.owner.releaseDocument();assert.equal(f.owner.pendingImport,null);assert.equal(f.owner.lifecycle.models,0);assert.deepEqual(totals(),{cpu:0,prompt:0,handles:0,records:0});
});

test('canceling an active move gesture keeps its pinned model until the deferred preview command drains',async t=>{
 const f=fixture(t),gate=deferred(),entered=deferred();
 f.setCommand(async body=>{assert.equal(body.type,'ComposeRaster');entered.resolve();return gate.promise;});
 f.owner.choose('Move');f.owner.pointerDown(nativeEvent(),[1,1]);f.owner.pointerMove(nativeEvent(),[5,6]);await entered.promise;
 f.owner.cancelGesture();assert.equal(f.owner.lifecycle.gestures,0);assert.equal(f.owner.lifecycle.actions,1);assert.ok(totals().cpu>0);
 let settled=false;const close=f.owner.releaseDocument().then(()=>{settled=true;});await flush();assert.equal(settled,false);assert.equal(f.owner.lifecycle.models,0);assert.ok(totals().cpu>0,'The pending command still owns the gesture and command input');
 gate.resolve(registered('late-composite'));await close;await flush();
 assert.equal(settled,true);assert.equal(f.displays.includes('late-composite'),false);assert.equal(f.owner.lifecycle.actions,0);assert.deepEqual(totals(),{cpu:0,prompt:0,handles:0,records:0});
});

test('refused asynchronous action admission releases its already acquired gesture pin',async t=>{
 const f=fixture(t);f.owner.choose('Move');f.owner.pointerDown(nativeEvent(),[1,1]);
 const occupied=allocationLedger.reserve({owner:'authoring-action-pressure',kind:'control',handles:ALLOCATION_LIMITS.handles-allocationLedger.snapshot().handles});pressures.add(occupied);
 f.owner.pointerMove(nativeEvent(),[5,6]);await flush();
 assert.equal(f.commands.length,0);assert.equal(f.owner.lifecycle.actions,0);assert.equal(f.owner.movePending,false);
 assert.equal(f.failures.length,1);assert.match(f.failures[0].message,/ALLOCATION_BUDGET/);
 await f.owner.releaseDocument();occupied.release();assert.deepEqual(totals(),{cpu:0,prompt:0,handles:0,records:0});
});

test('pointer release retains its action input until an asynchronous transform command drains',async t=>{
 const schedule=timers(t),f=fixture(t),gate=deferred(),entered=deferred();
 f.setCommand(async body=>{assert.equal(body.type,'ApplyTransform');entered.resolve();return gate.promise;});
 f.owner.choose('Move');f.owner.pointerDown(nativeEvent(),[1,1]);f.owner.pointerUp(nativeEvent(),[7,8]);await schedule.tick();await entered.promise;
 assert.equal(f.owner.lifecycle.gestures,0);assert.equal(f.owner.lifecycle.actions,1);assert.ok(totals().cpu>0);
 let settled=false;const close=f.owner.releaseDocument().then(()=>{settled=true;});await flush();assert.equal(settled,false);
 gate.resolve([]);await close;await flush();assert.equal(settled,true);assert.equal(f.owner.lifecycle.actions,0);assert.equal(f.commands.length,1);assert.deepEqual(totals(),{cpu:0,prompt:0,handles:0,records:0});
});

test('closing while mask preview preparation is pending drains the action without publishing a late preview',async t=>{
 const f=fixture(t),gate=deferred(),entered=deferred();f.owner.push({kind:'fill'});
 f.setCommand(async body=>{assert.equal(body.type,'PrepareMask');entered.resolve();return gate.promise;});
 const preview=f.owner.prepare(),rejection=assert.rejects(preview,error=>error.name==='AbortError');await entered.promise;
 let settled=false;const close=f.owner.releaseDocument().then(()=>{settled=true;});await flush();assert.equal(settled,false);assert.equal(f.owner.draft,null);assert.equal(f.owner.lifecycle.actions,1);assert.ok(totals().cpu>0);
 gate.resolve(registered('late-mask'));await rejection;await close;assert.equal(f.owner.preview,null);assert.equal(f.commands.length,1);assert.equal(f.owner.lifecycle.actions,0);assert.deepEqual(totals(),{cpu:0,prompt:0,handles:0,records:0});
});

test('a scheduled pointer-up callback cannot restore a selection after close even if invoked late',async t=>{
 const schedule=timers(t),f=fixture(t);f.owner.choose('Select');f.owner.pointerDown(nativeEvent(),[1,1]);f.owner.pointerUp(nativeEvent(),[8,9]);
 const callback=[...schedule.pending.values()][0];assert.equal(typeof callback,'function');assert.equal(f.owner.lifecycle.pendingPointer,1);
 await f.owner.releaseDocument();assert.equal(schedule.pending.size,0);assert.equal(f.owner.lifecycle.pendingPointer,0);assert.equal(f.owner.selection.length,0);
 callback();await flush();assert.equal(f.owner.selection.length,0);assert.equal(f.commands.length,0);assert.equal(f.saved.length,0);assert.equal(f.owner.lifecycle.actions,0);assert.deepEqual(totals(),{cpu:0,prompt:0,handles:0,records:0});
});

test('a settled form callback queued before close cannot allocate or change the released form',async t=>{
 const f=fixture(t),handler=field(f.owner.render(),'Selection width').values.at(-1);handler(nativeEvent('250'));
 await f.owner.releaseDocument();await flush();assert.equal(f.owner.width,'100');assert.equal(f.owner.lifecycle.models,0);assert.deepEqual(totals(),{cpu:0,prompt:0,handles:0,records:0});
});


const maskCheckpoint=saved=>({sessionId:'session',uiSeq:'1',preferences:{documentId:'document',tool:'mask',viewport:{x:0,y:0,zoom:1},panels:{left:280,right:320,active:'layers'},selectedLayerIds:['layer']},drafts:[saved],reconciledLayerIds:[]});

test('restoring a saved mask refuses before JSON.parse when the retained text fits but the parsed model does not',async t=>{
 const f=fixture(t),text=JSON.stringify({schema:'local-mask-1',layerVersion:'1',radius:'0',plan:{width:20,height:20,feather:0,operations:Array.from({length:20},()=>({kind:'fill'}))}});
 const saved={id:'saved-mask',kind:'mask',documentId:'document',targetLayerId:'layer',expectedDocumentRevision:'1',generation:'1',composing:false,assetId:'saved-caption',status:'saved-unapplied',maskBindings:{}};
 const drafts=new DraftPersistence('session',async()=>{throw Error('Retained draft must avoid another read');},()=> 'csrf');draftOwners.add(drafts);
 drafts.checkpoint=maskCheckpoint(saved);drafts.drafts.set(saved.id,{...saved,text,savedGeneration:'1',pending:false,error:null});f.editor.draftOwner=drafts;f.editor.ui=drafts.checkpoint;
 const retained=totals(),occupied=pressure(t,modelPayloadBytes(saved)+text.length*2);let parses=0;const parse=JSON.parse;t.mock.method(JSON,'parse',(...args)=>{parses++;return parse(...args);});
 await f.owner.sync();assert.equal(parses,0);assert.equal(f.owner.draft,null);assert.equal(drafts.drafts.get(saved.id).text,text);assert.equal(f.owner.lifecycle.actions,0);assert.equal(f.owner.lifecycle.models,0);assert.match(f.failures.at(-1).message,/ALLOCATION_BUDGET/);
 occupied.release();assert.deepEqual(totals(),retained);
});

test('document close cancels and drains a pending saved-mask body read before releasing the authoring response owner',async t=>{
 const f=fixture(t),entered=deferred();let canceled=0;
 const saved={id:'saved-mask',kind:'mask',documentId:'document',targetLayerId:'layer',expectedDocumentRevision:'1',generation:'1',composing:false,assetId:'saved-caption',status:'saved-unapplied',maskBindings:{}};
 f.editor.session.transport=async(path)=>{assert.equal(path,'/api/v1/assets/saved-caption/content');const body=new ReadableStream({start(){entered.resolve();},cancel(){canceled++;}});return new Response(body,{headers:{'content-length':'100'}});};
 const drafts=new DraftPersistence('session',f.editor.session.transport,()=> 'csrf');draftOwners.add(drafts);drafts.checkpoint=maskCheckpoint(saved);f.editor.draftOwner=drafts;f.editor.ui=drafts.checkpoint;
 // The editor's checkpoint remains owned after the authoring response drains.
 const checkpoint=drafts.checkpoint,retained=totals();assert.ok(retained.cpu>0);
 const restore=f.owner.sync();await entered.promise;await flush();assert.ok(totals().handles>retained.handles);await f.owner.releaseDocument();await restore;
 assert.equal(canceled,1);assert.equal(f.owner.draft,null);assert.equal(drafts.drafts.size,0);assert.equal(f.owner.lifecycle.actions,0);assert.equal(drafts.checkpoint,checkpoint);assert.equal(drafts.ownership.checkpointModels,1);assert.deepEqual(totals(),retained);
 await drafts.dispose();assert.deepEqual(totals(),{cpu:0,prompt:0,handles:0,records:0});
});


test('a refused sampled result preserves all coordinates, formatted sample text and color together',async t=>{
 const f=fixture(t);f.owner.sampleX='7';f.owner.sampleY='8';const before=accepted(f),retained=totals();let occupied;
 f.editor.ownedJSON=async()=>{const response=cloneOwnedModel('authoring-sample-test',{rgba:[11,22,33,44]});occupied=pressure(t,modelPayloadBytes(f.owner.form));return response;};
 await assert.rejects(f.owner.sample(3,4),/ALLOCATION_BUDGET/);unchanged(f,before);occupied.release();assert.deepEqual(totals(),retained);
});

test('old Lit form values remain charged until the supplied host commit and close awaits that commit',async t=>{
 const gate=deferred(),f=fixture(t,()=>gate.promise);f.owner.width='101';const first=totals();f.owner.width='102';await flush();
 assert.equal(f.owner.lifecycle.retiredModels,1);assert.ok(totals().cpu>first.cpu);let closed=false;const close=f.owner.releaseDocument().then(()=>{closed=true;});await flush();assert.equal(closed,false);assert.equal(f.owner.lifecycle.models,0);assert.ok(totals().cpu>0);
 gate.resolve(true);await close;assert.equal(f.owner.lifecycle.retiredModels,0);assert.equal(f.owner.lifecycle.liveModels,0);assert.deepEqual(totals(),{cpu:0,prompt:0,handles:0,records:0});
});

test('a failed host commit retains actual models for a later confirmed retirement retry',async t=>{
 let fail=true;const f=fixture(t,async()=>{if(fail)throw Error('Host commit failed');});f.owner.width='101';f.owner.width='102';await flush();assert.equal(f.owner.lifecycle.failedRetirements,1);
 await assert.rejects(f.owner.releaseDocument(),/AUTHORING_DOCUMENT_CLEANUP/);assert.ok(f.owner.lifecycle.failedRetirements>0);assert.ok(totals().cpu>0);
 fail=false;await f.owner.releaseDocument();assert.equal(f.owner.lifecycle.failedRetirements,0);assert.equal(f.owner.lifecycle.liveModels,0);assert.deepEqual(totals(),{cpu:0,prompt:0,handles:0,records:0});
});

test('render-retired generations share a finite model cap and refuse before replacing the accepted field',async t=>{
 const gate=deferred(),f=fixture(t,()=>gate.promise);for(let i=0;i<96;i++)f.owner.width=String(1000+i);const before=f.owner.form;
 assert.throws(()=>{f.owner.width='9999';},/AUTHORING_MODEL_CAPACITY/);assert.equal(f.owner.form,before);assert.equal(f.owner.lifecycle.liveModels,96);
 const close=f.owner.releaseDocument();gate.resolve(true);await close;assert.equal(f.owner.lifecycle.liveModels,0);assert.deepEqual(totals(),{cpu:0,prompt:0,handles:0,records:0});
});


test('polygon input admission refusal restores the actual native control and accepted text',t=>{
 const f=fixture(t);f.owner.shape='polygon';f.owner.polygon='0,0 10,0 10,10';const before=accepted(f),retained=totals();
 const find=value=>{if(value?.strings?.[0].includes('<en-textarea label="Polygon points'))return value;for(const child of Array.isArray(value)?value:value?.values??[]){const found=find(child);if(found)return found;}return null;};
 const template=find(f.owner.render()),handler=template.values.at(-1),occupied=pressure(t),event=nativeEvent('0,0 20,0 20,20');handler(event);
 unchanged(f,before);assert.equal(event.currentTarget.value,before.form.polygon);assert.match(f.failures.at(-1).message,/ALLOCATION_BUDGET/);occupied.release();assert.deepEqual(totals(),retained);
});

test('Zoom primary click consumes the gesture and dispatches the exact document anchor with Alt direction',async t=>{
 const schedule=timers(t),f=fixture(t);f.owner.choose('Zoom');const retained=totals();
 for(const out of [false,true]){const event=nativeEvent();event.altKey=out;assert.equal(f.owner.pointerDown(event,[3.25,6.5]),true);assert.equal(f.owner.pointerUp(event,[3.25,6.5]),true);await schedule.tick();}
 assert.deepEqual(f.zooms,[{point:[3.25,6.5],out:false},{point:[3.25,6.5],out:true}]);assert.deepEqual(f.commands,[]);assert.deepEqual(f.displays,[]);assert.deepEqual(totals(),retained);
 const secondary=nativeEvent();secondary.button=2;assert.equal(f.owner.pointerDown(secondary,[1,1]),false);assert.equal(f.owner.lifecycle.gestures,0);f.editor.view.busy=true;assert.equal(f.owner.pointerDown(nativeEvent(),[1,1]),true);assert.equal(f.owner.lifecycle.gestures,0);
});

test('Zoom drag, pointer cancellation and later default prevention do not change the viewport',async t=>{
 const schedule=timers(t),f=fixture(t);f.owner.choose('Zoom');const retained=totals(),down=nativeEvent(),moved=nativeEvent();moved.clientX+=5;
 f.owner.pointerDown(down,[3,4]);assert.equal(f.owner.pointerMove(moved,[8,4]),true);f.owner.pointerUp(moved,[8,4]);await schedule.tick();
 f.owner.pointerDown(down,[3,4]);f.owner.cancelGesture();assert.equal(f.owner.pointerUp(down,[3,4]),false);await schedule.tick();
 f.owner.pointerDown(down,[3,4]);const up=nativeEvent();f.owner.pointerUp(up,[3,4]);up.preventDefault();await schedule.tick();
 assert.deepEqual(f.zooms,[]);assert.deepEqual(f.commands,[]);assert.deepEqual(f.displays,[]);assert.deepEqual(totals(),retained);
});

test('Zoom click closed before its deferred dispatch releases the gesture without calling the viewport',async t=>{
 const schedule=timers(t),f=fixture(t);f.owner.choose('Zoom');const event=nativeEvent();f.owner.pointerDown(event,[4,5]);f.owner.pointerUp(event,[4,5]);assert.equal(f.owner.lifecycle.pendingPointer,1);
 await f.owner.releaseDocument();await schedule.tick();assert.deepEqual(f.zooms,[]);assert.deepEqual(totals(),{cpu:0,prompt:0,handles:0,records:0});
});


test('mask preview copies each borrowed asset before its command response is released',async t=>{
 const f=fixture(t);f.owner.push({kind:'fill'});await f.owner.prepare();
 assert.deepEqual(f.responses.map(r=>r.type),['PrepareMask','ComposeRaster','PrepareMask']);
 assert(f.responses.every(r=>!r.active));assert.equal(f.owner.preview.mask.id,'mask-1');
 assert.deepEqual(f.owner.preview.after,{raster:{width:20,height:20}});
 assert.equal(f.owner.preview.views.result,'blob:authoring-composite-2');assert.equal(f.owner.preview.views.hard,'blob:authoring-mask-3');
 assert(f.responses.every(r=>r.value[0].payload.asset.id==='released-event'));
});

test('move preview owns the actual event root until its asynchronous display consumer settles',async t=>{
 const f=fixture(t),entered=deferred(),gate=deferred();f.setDisplay(async()=>{assert.equal(f.responses.at(-1).active,true);entered.resolve();await gate.promise;assert.equal(f.responses.at(-1).active,true);});
 f.owner.choose('Move');f.owner.pointerDown(nativeEvent(),[1,1]);f.owner.pointerMove(nativeEvent(),[5,6]);await entered.promise;
 const row=f.responses.at(-1);assert.equal(row.value[0].payload.asset.id,'composite-1');assert.equal(row.active,true);
 let done=false;const closing=f.owner.releaseDocument().then(()=>{done=true;});await flush();assert.equal(done,false);assert.equal(row.active,true);assert.ok(totals().cpu>0);
 gate.resolve();await closing;assert.equal(row.active,false);assert.equal(row.value[0].payload.asset.id,'released-event');assert.deepEqual(totals(),{cpu:0,prompt:0,handles:0,records:0});
});

test('event-to-model refusal releases the response and preserves the accepted mask draft',async t=>{
 const f=fixture(t);f.owner.push({kind:'fill'});const before=accepted(f),retained=totals();let blocker;
 f.setResponseInspection(row=>{assert.equal(row.type,'PrepareMask');assert.equal(row.active,true);blocker=pressure(t);});
 await assert.rejects(f.owner.prepare(),/ALLOCATION_BUDGET/);assert.equal(f.responses.length,1);assert.equal(f.responses[0].active,false);unchanged(f,before);
 blocker.release();assert.deepEqual(totals(),retained);
});

test('a rejected display consumer releases its command response and gesture action pins',async t=>{
 const f=fixture(t),failure=Error('display failed');f.setDisplay(async()=>{assert.equal(f.responses.at(-1).active,true);throw failure;});
 f.owner.choose('Move');f.owner.pointerDown(nativeEvent(),[1,1]);const gesture=f.owner.gesture;await assert.rejects(f.owner.previewMove(gesture),e=>e===failure);
 assert.equal(f.responses.length,1);assert.equal(f.responses[0].active,false);assert.equal(f.owner.movePending,false);assert.equal(f.owner.lifecycle.actions,0);
 await f.owner.releaseDocument();assert.deepEqual(totals(),{cpu:0,prompt:0,handles:0,records:0});
});

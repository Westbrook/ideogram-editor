import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {allocationsURL,promptMemoryURL,allocationDeltaSnapshot}=await import(pathToFileURL(resolve('tests/owned-preview-module.mjs')).href);
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function module(path,replacements={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const root=(process.env.IE_IMPORT_STAGING??'.').replace(/\/$/,'')+'/';
const model=await module('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptMemoryURL});
const displayControl=await module('src/observability/display-control.ts',{'./model-memory.js':model});
const urls=new Set();globalThis.__imageImportURLs=urls;
const display=data(`import {readOwnedDisplayControl,DISPLAY_SOURCE_CONTROL_BYTES} from ${JSON.stringify(displayControl)};let nextPreview=0;
 export async function withDisplaySource(transport,id,options,consume){const owner=await readOwnedDisplayControl('fixture-display-source',DISPLAY_SOURCE_CONTROL_BYTES,()=>readDisplaySource(transport,id,options));try{return await consume(owner.value);}finally{owner.release();}}
 export async function readDisplaySource(_transport,id){return {assetId:id};}export async function createDisplayPreviewURL(_transport,source){const url='blob:'+source.assetId+':'+(++nextPreview);globalThis.__imageImportURLs.add(url);return url;}export function revokeDisplayPreviewURL(url){globalThis.__imageImportURLs.delete(url);}export function validateDisplayImage(element,url){if(element.src!==url||element.naturalWidth!==4)throw Error('Preview is not decoded');}`);
const code=await module(root+'src/ui/image-import.ts',{'lit':data('export const nothing=null;export const html=(strings,...values)=>({strings,values});'),'../observability/allocations.js':allocationsURL,'../observability/model-memory.js':model,'../observability/prompt-memory.js':promptMemoryURL,'../observability/display-preview.js':display,'./display-image.js':data('export const displayImage=x=>x;'),'./adapters.js':await module('src/ui/adapters.ts')});
const {ImageImportControls}=await import(code),{allocationLedger}=await import(allocationsURL),{createOwnedModel,modelPayloadBytes}=await import(model);
// Freeze only the shared instrumentation baseline; controller owners must still drain.
const allocations=allocationDeltaSnapshot(allocationLedger);
// A snapshot itself advances these two observation-read sequences. Keep every
// resource, ownership-transition, peak, coverage and ledger-identity field.
function allocationResources(){const value=structuredClone(allocations());delete value.combinedCpu.sequence;delete value.appOwnership.point.cpuSequence;return value;}
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
const file=name=>new File(['pixels'],name,{type:'image/png'});
const owners=new Set();
test.afterEach(async()=>{for(const owner of owners)await owner.releaseDocument();owners.clear();assert.equal(urls.size,0);const ledger=allocations();assert.equal(ledger.cpuBytes,0);assert.equal(ledger.handles,0);});
function fixture(){
 const responseOwners=[];const ownResponse=(value,kind)=>{const payload=createOwnedModel('image-import-test-response',modelPayloadBytes(value),()=>structuredClone(value)),record={kind,released:false,value:payload.value};responseOwners.push(record);return {value:payload.value,pin:()=>payload.pin(),release(){assert.equal(record.released,false,'Exact response released once');record.released=true;payload.release();}};};
 const calls=[],deliveries=new Map(),results=new Map();let number=0;const context={resumeGate:null,resumeRead:null,resumeReleased:0,failName:'',interruptImport:false,uploadGate:null,uploadSignal:null,oversized:false,unavailable:false,blockedType:'',commandGate:null,commandFailure:false,journalGate:null,journalStarted:false,activeCommand:null,cancelGate:null,cancelFailure:false,cancelCompleted:false,cancelCalls:[]};
 const editor={async ownedUpload(...args){return ownResponse(await this.upload(...args),'upload');},async ownedCommand(...args){return ownResponse(await this.command(...args),args[0].type);},async ownedRetry(...args){return ownResponse(await this.retry(...args),'retry');},async ownedCancelRasterImport(...args){return ownResponse(await this.cancelRasterImport(...args),'cancel');},view:{ready:true,busy:false,document:{id:'existing',revision:'1'}},sessionId:'session',documentEpoch:1,session:{identity:()=> 'client',transport:async()=>{throw Error('Unexpected fetch');}},
  async run(_label,work){assert.equal(this.view.busy,false);this.view.busy=true;try{await work();}finally{this.view.busy=false;}},
  async upload(source,_purpose,_mime,_existing,owns,signal){calls.push({type:'upload',name:source.name});context.uploadSignal=signal;if(context.uploadGate)await context.uploadGate.promise;if(!owns()||signal.aborted)throw Error('UPLOAD_OWNER_CHANGED');return {stagingId:source.name,sha256:'original-'+source.name};},
  async command(body,target,newId,onJournaled){const id='command-'+(++number);deliveries.set(id,{body:structuredClone(body),target:target?{...target}:null,newId});if(body.type===context.blockedType&&context.journalGate){context.journalStarted=true;await context.journalGate.promise;}onJournaled?.(id);calls.push({id,...deliveries.get(id)});if(body.type===context.blockedType&&context.commandGate){context.activeCommand=id;await context.commandGate.promise;if(context.commandFailure)throw Error('Original delivery interrupted');}if(results.get(id)?.rejected)throw Error('RASTER_IMPORT_CANCELED');const events=results.get(id)?.events??execute(deliveries.get(id));results.set(id,{events});if(body.type==='PrepareRaster'&&body.assetId.includes(context.failName)&&context.failName){results.set(id,{rejected:true});throw Error('UNSUPPORTED_IMAGE');}if(body.type==='ImportAsset'&&context.interruptImport){context.interruptImport=false;throw Error('Connection interrupted after acceptance');}return events;},
  async cancelRasterImport(id,owner){context.cancelCalls.push({id,owner});assert.equal(owner.session,this.session);assert.equal(owner.identity,this.session.identity());if(context.cancelGate)await context.cancelGate.promise;if(context.cancelFailure)throw Error('Cancellation connection interrupted');const completed=context.cancelCompleted||!!results.get(id)?.events;if(completed&&!results.get(id))results.set(id,{events:execute(deliveries.get(id))});if(!completed)results.set(id,{rejected:true});context.commandGate?.resolve();return {protocolVersion:1,commandId:id,status:completed?'completed':'canceled',receipt:completed?{status:'accepted',commandId:id,fromSeq:'1',toSeq:'1',documentRevision:null,transactionId:'transaction'}:{status:'rejected',commandId:id,code:'INVALID_INPUT',currentRevision:null,details:{hash:'sha256:'+'1'.repeat(64),byteLength:'1',mediaType:'application/json'}}};},
  async retry(id){calls.push({type:'retry',id});const result=results.get(id);if(result.rejected)throw Error('Rejected original');return result.events;},
  async ownedJSON(path){if(path.includes('/staging/')){context.resumeRead=path;if(context.resumeGate)await context.resumeGate.promise;return {value:{protocolVersion:1,stagingId:path.split('/').at(-1),purpose:'image',expectedBytes:'6',sha256:'source',mediaType:'image/png',ownerClientId:'client',version:'1',committedOffset:'0',state:'receiving'},release(){context.resumeReleased++;}};}if(path.includes('/commands/')){const result=results.get(path.split('/').at(-1));return {value:{kind:'receipt',receipt:{status:result?.rejected?'rejected':'accepted'}},release(){}};}const id=path.split('/').at(-1);if(path.includes('/raster-import-inspections/'))return {value:{protocolVersion:1,inspectionId:id,inspectionHash:'hash-'+id,assetId:id.slice('inspect-'.length),assetVersion:'1',original:{hash:'original',byteLength:'6',mediaType:'image/png'},encoded:{width:context.oversized?10000:4,height:4},orientation:1,profile:'srgb',profileHash:null,samplesValidated:false,targetClientId:'client',expiresAt:'2099-01-01',capabilities:{resize:context.unavailable?null:'test-bounded-resize',crop:context.unavailable?null:'test-bounded-crop',unavailableReason:context.unavailable?'Codec has no bounded resize/crop capability.':null}},release(){}};const assetId=id.slice('review-'.length);return {value:{protocolVersion:1,reviewId:id,reviewHash:'hash-'+id,assetId,previewAssetId:assetId,targetClientId:'client',expiresAt:'2099-01-01',conversion:{profile:'srgb',orientationChanged:false,colorChanged:false}},release(){}};},
  async open(id){calls.push({type:'open',id});this.documentEpoch++;this.view.document={id,revision:'1'};}
 };
 function execute({body,target,newId}){
  if(body.type==='FinalizeStaging')return [{type:'AssetRegistered',payload:{asset:{id:'original-'+body.stagingId}}}];
  if(body.type==='InspectRasterOriginal')return [{type:'RasterImportInspectionPrepared',payload:{inspectionId:'inspect-'+body.assetId,inspectionHash:'hash-inspect-'+body.assetId}}];
  if(body.type==='PrepareRaster')return [{type:'AssetRegistered',payload:{asset:{id:'raster-'+body.assetId,raster:{width:body.importPlan?.operation.width??4,height:body.importPlan?.operation.height??4}}}}];
  if(body.type==='ReviewRaster')return [{type:'RasterReviewPrepared',payload:{reviewId:'review-'+body.assetId,reviewHash:'hash-review-'+body.assetId}}];
  if(body.type==='ApproveRaster')return [{type:'AssetRegistered',payload:{asset:{id:'approved-'+body.assetId}}}];
  if(body.type==='NewDocument')return [{type:'DocumentCreated',payload:{document:{id:newId,revision:'1'}}}];
  if(body.type==='ImportAsset'){const revision=String(Number(target.revision)+1);if(editor.view.document.id===target.id)editor.view.document={id:target.id,revision};return [{type:'ImageEdited',documentId:target.id,resultingDocumentRevision:revision}];}
  throw Error('Unexpected command '+body.type);
 }
 const host={updateComplete:Promise.resolve(),requestUpdate(){}};const controller=new ImageImportControls(host,editor);owners.add(controller);
 const ready=()=>{for(const row of controller.rows)if(row.state==='ready')controller.loaded(row.id,{currentTarget:{src:row.url,naturalWidth:4}});};
 return {controller,editor,calls,context,deliveries,ready,host,responseOwners};
}
test('batch retains originals before conversion and requires decoded explicit valid-subset confirmation',async()=>{
 const f=fixture();f.context.failName='bad.png';await f.controller.select([file('first.png'),file('bad.png'),file('third.png')]);
 assert.deepEqual(f.controller.rows.map(row=>row.state),['ready','failed','ready']);assert.equal(f.calls.some(call=>call.body?.type==='ImportAsset'),false);
 const first=f.controller.rows[0],third=f.controller.rows[2];f.controller.selectItem(first.id,true);assert.equal(first.selected,false);f.ready();f.controller.selectItem(first.id,true);await f.controller.apply();
 const imports=f.calls.filter(call=>call.body?.type==='ImportAsset');assert.equal(imports.length,1);assert.equal(imports[0].body.name,'first.png');assert.equal(third.state,'ready');assert.equal(third.selected,false);assert.equal(f.controller.rows[1].state,'failed');
 for(const raster of f.calls.filter(call=>call.body?.type==='PrepareRaster')){const original=f.calls.findIndex(call=>call.body?.type==='FinalizeStaging'&&'original-'+call.body.stagingId===raster.body.assetId);assert(original>=0&&original<f.calls.indexOf(raster));}
});
test('new-document choice works while a document is open and creates one destination per chosen image',async()=>{
 const f=fixture();await f.controller.select([file('one.png'),file('two.png')]);f.ready();f.controller.chooseDestination('new');for(const row of f.controller.rows)f.controller.selectItem(row.id,true);await f.controller.apply();
 const creates=f.calls.filter(call=>call.body?.type==='NewDocument'),imports=f.calls.filter(call=>call.body?.type==='ImportAsset');assert.equal(creates.length,2);assert.equal(imports.length,2);assert.notEqual(imports[0].target.id,imports[1].target.id);assert(imports.every(call=>call.target.id!=='existing'));assert.equal(f.editor.view.document.revision,'1');assert(f.controller.rows.every(row=>row.state==='applied'));
});
test('current-document batch follows only its own accepted revision chain',async()=>{
 const f=fixture();await f.controller.select([file('one.png'),file('two.png')]);f.ready();for(const row of f.controller.rows)f.controller.selectItem(row.id,true);await f.controller.apply();assert.deepEqual(f.calls.filter(call=>call.body?.type==='ImportAsset').map(call=>call.target),[{id:'existing',revision:'1'},{id:'existing',revision:'2'}]);
});
test('external revision change refuses the captured destination without importing',async()=>{
 const f=fixture();await f.controller.select([file('one.png')]);f.ready();f.controller.selectItem(f.controller.rows[0].id,true);f.editor.view.document={id:'existing',revision:'9'};await assert.rejects(f.controller.apply(),/destination changed/);assert.equal(f.calls.some(call=>call.body?.type==='ApproveRaster'),false);
});
test('interrupted accepted import resolves the original delivery and never creates a second layer',async()=>{
 const f=fixture();await f.controller.select([file('one.png')]);f.ready();const row=f.controller.rows[0];f.controller.selectItem(row.id,true);f.context.interruptImport=true;await f.controller.apply();assert.equal(row.state,'uncertain');const id=row.pending.id;await f.controller.retry(row.id);assert.equal(row.state,'applied');assert.equal(f.calls.filter(call=>call.body?.type==='ImportAsset').length,1);assert.deepEqual(f.calls.filter(call=>call.type==='retry'),[{type:'retry',id}]);
});
test('Stop aborts an active upload, drains its exact promise, and never starts later items',async()=>{
 const f=fixture(),gate=deferred();f.context.uploadGate=gate;const preparing=f.controller.select([file('one.png'),file('two.png')]);for(let i=0;i<32&&!f.context.uploadSignal;i++)await Promise.resolve();assert(f.context.uploadSignal);f.controller.stop();assert.equal(f.context.uploadSignal.aborted,true);let released=false;const closing=f.controller.releaseDocument().then(()=>{released=true;});await Promise.resolve();assert.equal(released,false);gate.resolve();await preparing;await closing;assert.equal(f.calls.filter(call=>call.type==='upload').length,1);assert.equal(f.calls.some(call=>call.body),false);assert.equal(f.controller.inspect().files,0);
});
test('owner replacement fences conversion publication while preserving the original outcome',async()=>{
 const f=fixture(),gate=deferred();f.context.uploadGate=gate;const preparing=f.controller.select([file('one.png')]);for(let i=0;i<32&&!f.context.uploadSignal;i++)await Promise.resolve();f.editor.documentEpoch++;gate.resolve();await preparing;assert.equal(f.controller.rows[0].state,'cancelled');assert.equal(f.calls.some(call=>call.body?.type==='PrepareRaster'),false);assert.equal(urls.size,0);
});

test('oversized original pauses before decode, requires explicit dimensions, and keeps original identity in its plan',async()=>{
 const f=fixture();f.context.oversized=true;await f.controller.select([file('wide.png')]);const row=f.controller.rows[0];assert.equal(row.state,'needs-size');assert(row.originalId);assert.equal(f.calls.some(call=>call.body?.type==='PrepareRaster'),false);
 f.controller.changeSize(row.id,'width',100);f.controller.changeSize(row.id,'height',4);await f.controller.prepareSize(row.id,'resize');const prepare=f.calls.find(call=>call.body?.type==='PrepareRaster');assert.equal(prepare.body.assetId,row.originalId);assert.deepEqual(prepare.body.importPlan,{inspectionId:row.inspection.inspectionId,inspectionHash:row.inspection.inspectionHash,operation:{kind:'resize',width:100,height:4}});assert.equal(row.state,'ready');assert.equal(row.selected,false);assert.equal(f.calls.some(call=>call.body?.type==='ImportAsset'),false);
 f.controller.changeSize(row.id,'width',99);assert.equal(row.prepared,undefined);assert.equal(row.url,'');assert.equal(row.state,'needs-size');assert.equal(row.selected,false);
});
test('unavailable oversized codec and out-of-bounds crop never issue hidden decode requests',async()=>{
 const f=fixture();f.context.oversized=true;f.context.unavailable=true;await f.controller.select([file('wide.png')]);let row=f.controller.rows[0];assert.throws(()=>f.controller.prepareSize(row.id,'resize'),/no bounded/);assert.throws(()=>f.controller.prepareSize(row.id,'crop'),/no bounded/);assert.equal(f.calls.some(call=>call.body?.type==='PrepareRaster'),false);
 await f.controller.releaseDocument();f.context.unavailable=false;await f.controller.select([file('wide.png')]);row=f.controller.rows[0];f.controller.changeSize(row.id,'x',9999);f.controller.changeSize(row.id,'width',2);assert.throws(()=>f.controller.prepareSize(row.id,'crop'),/inside the oriented/);assert.equal(f.calls.some(call=>call.body?.type==='PrepareRaster'),false);
});

test('resume transfer after prior close uses a fresh signal and releases read ownership before upload',async()=>{
 const f=fixture();await f.controller.releaseDocument();await f.controller.resumeTransfer(file('one.png'),'retained-stage');assert.equal(f.context.resumeReleased,1);assert.equal(f.controller.rows[0].resume.stagingId,'retained-stage');assert.equal(f.controller.rows[0].state,'ready');assert.equal(f.context.uploadSignal.aborted,false);
});
test('close during resume read waits for the exact task and fences upload after owner release',async()=>{
 const f=fixture(),gate=deferred();f.context.resumeGate=gate;const reading=f.controller.resumeTransfer(file('one.png'),'retained-stage');for(let i=0;i<32&&!f.context.resumeRead;i++)await Promise.resolve();assert(f.context.resumeRead);let closed=false;const closing=f.controller.releaseDocument().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);gate.resolve();await reading;await closing;assert.equal(f.context.resumeReleased,1);assert.equal(f.calls.some(call=>call.type==='upload'),false);assert.equal(f.controller.inspect().pendingOperations,0);
});
test('file owners survive a failed replacement render until a successful close retry',async()=>{
 const f=fixture();await f.controller.select([file('one.png')]);const admitted=allocations().cpuBytes;f.host.updateComplete=Promise.reject(Error('render failed'));await assert.rejects(f.controller.releaseDocument(),/render failed/);assert.equal(f.controller.inspect().files,1);assert(allocations().cpuBytes>0&&allocations().cpuBytes<=admitted);f.host.updateComplete=Promise.resolve();await f.controller.releaseDocument();assert.equal(f.controller.inspect().files,0);assert.equal(allocations().cpuBytes,0);
});
test('batch bounds are enforced before replacing the existing review',async()=>{
 const f=fixture();await f.controller.select([file('kept.png')]);const id=f.controller.rows[0].id;await assert.rejects(f.controller.select(Array.from({length:33},(_,i)=>file(i+'.png'))),/up to 32/);assert.equal(f.controller.rows[0].id,id);assert.equal(f.calls.filter(call=>call.type==='upload').length,1);
});

test('explicit new-document destination chosen before files survives batch admission',async()=>{
 const f=fixture();f.controller.begin();f.controller.chooseDestination('new');await f.controller.select([file('chosen.png')]);assert.equal(f.controller.destination,'new');f.ready();f.controller.selectItem(f.controller.rows[0].id,true);await f.controller.apply();assert.equal(f.calls.filter(call=>call.body?.type==='NewDocument').length,1);assert.equal(f.editor.view.document.id,'existing');
});
test('expired oversized inspection refreshes the retained original and requires a new explicit plan',async()=>{
 const f=fixture();f.context.oversized=true;await f.controller.select([file('wide.png')]);const row=f.controller.rows[0],original=row.originalId;row.inspection.expiresAt='2000-01-01';f.controller.changeSize(row.id,'width',100);await f.controller.prepareSize(row.id,'resize');assert.equal(row.state,'needs-size');assert.equal(row.plan,undefined);assert.equal(row.originalId,original);assert.equal(row.size.width,100);assert.equal(f.calls.filter(call=>call.body?.type==='InspectRasterOriginal').length,2);assert.equal(f.calls.some(call=>call.body?.type==='PrepareRaster'),false);await f.controller.prepareSize(row.id,'resize');assert.equal(row.state,'ready');assert.equal(f.calls.filter(call=>call.body?.type==='PrepareRaster').length,1);
});
test('only a durable rejected preparation invalidates the old plan and inspection for retry',async()=>{
 const f=fixture();f.context.oversized=true;await f.controller.select([file('wide.png')]);const row=f.controller.rows[0];f.context.failName='wide';await f.controller.prepareSize(row.id,'resize');assert.equal(row.state,'failed');assert.equal(row.pending,undefined);assert.equal(row.inspection,undefined);assert.equal(row.plan,undefined);f.context.failName='';await f.controller.retry(row.id);assert.equal(row.state,'needs-size');assert.equal(f.calls.filter(call=>call.body?.type==='PrepareRaster').length,1);assert.equal(f.calls.filter(call=>call.body?.type==='InspectRasterOriginal').length,2);
});

async function reached(predicate){for(let i=0;i<256&&!predicate();i++)await Promise.resolve();assert(predicate(),'Expected controlled async boundary was not reached');}
for(const type of ['InspectRasterOriginal','PrepareRaster'])test('Stop durably cancels the original '+type+' and never starts a later image',async()=>{
 const f=fixture(),gate=deferred();f.context.blockedType=type;f.context.commandGate=gate;
 const preparing=f.controller.select([file('first.png'),file('second.png')]);
 try{await reached(()=>!!f.context.activeCommand);const id=f.context.activeCommand;f.controller.stop();await preparing;
  assert.deepEqual(f.context.cancelCalls.map(call=>call.id),[id]);assert.equal(f.controller.rows[0].state,'cancelled');assert.equal(f.controller.rows[0].pending,undefined);assert.equal(f.controller.rows[0].originalId,'original-first.png');assert.equal(f.controller.rows[1].state,'cancelled');assert.equal(f.calls.filter(call=>call.type==='upload').length,1);assert.equal(f.calls.some(call=>call.body?.type==='ApproveRaster'||call.body?.type==='ImportAsset'),false);
 }finally{gate.resolve();await preparing;}
});
test('per-image cancellation drains preparation before continuing the next queued image',async()=>{
 const f=fixture(),gate=deferred(),cancelGate=deferred();f.context.blockedType='PrepareRaster';f.context.commandGate=gate;f.context.cancelGate=cancelGate;
 const preparing=f.controller.select([file('first.png'),file('second.png')]);
 try{await reached(()=>!!f.context.activeCommand);const first=f.controller.rows[0],canceling=f.controller.cancelItem(first.id);await reached(()=>f.context.cancelCalls.length===1);
  assert.equal(f.calls.filter(call=>call.type==='upload').length,1);assert(first.cancellation);cancelGate.resolve();await canceling;await preparing;
  assert.equal(first.state,'cancelled');assert.equal(first.pending,undefined);assert.equal(f.controller.rows[1].state,'ready');assert.equal(f.context.cancelCalls.length,1);assert.equal(f.calls.some(call=>call.body?.type==='ImportAsset'),false);
 }finally{cancelGate.resolve();gate.resolve();await preparing;}
});
test('Stop before journaling cancels the subsequently admitted exact original ID',async()=>{
 const f=fixture(),journal=deferred(),gate=deferred();f.context.blockedType='InspectRasterOriginal';f.context.journalGate=journal;f.context.commandGate=gate;
 const preparing=f.controller.select([file('first.png')]);
 try{await reached(()=>f.context.journalStarted);f.controller.stop();assert.equal(f.context.cancelCalls.length,0);journal.resolve();await preparing;
  const original=f.calls.find(call=>call.body?.type==='InspectRasterOriginal');assert(original);assert.deepEqual(f.context.cancelCalls.map(call=>call.id),[original.id]);assert.equal(f.controller.rows[0].state,'cancelled');assert.equal(f.calls.filter(call=>call.body?.type==='InspectRasterOriginal').length,1);
 }finally{journal.resolve();gate.resolve();await preparing;}
});
test('unknown cancellation and original transport failures retain the original pending identity',async()=>{
 const f=fixture(),gate=deferred();f.context.blockedType='PrepareRaster';f.context.commandGate=gate;f.context.cancelFailure=true;f.context.commandFailure=true;
 const preparing=f.controller.select([file('first.png')]);
 try{await reached(()=>!!f.context.activeCommand);const row=f.controller.rows[0],id=row.pending.id;await f.controller.cancelItem(row.id);assert.equal(row.pending.id,id);assert.equal(row.state,'uncertain');assert.match(row.error,/unconfirmed/);gate.resolve();await preparing;
  assert.equal(row.pending.id,id);assert.equal(row.state,'uncertain');assert.equal(row.cancelOutcome,undefined);assert.equal(f.calls.filter(call=>call.body?.type==='PrepareRaster').length,1);assert.equal(f.calls.some(call=>call.body?.type==='ApproveRaster'||call.body?.type==='ImportAsset'),false);
 }finally{gate.resolve();await preparing;}
});
test('completion that wins cancellation retains the accepted preparation and does not import it',async()=>{
 const f=fixture(),gate=deferred();f.context.blockedType='PrepareRaster';f.context.commandGate=gate;f.context.cancelCompleted=true;
 const preparing=f.controller.select([file('first.png')]);
 try{await reached(()=>!!f.context.activeCommand);const row=f.controller.rows[0];await f.controller.cancelItem(row.id);await preparing;
  assert.equal(row.cancelOutcome,'completed');assert.equal(row.raster.id,'raster-original-first.png');assert.equal(row.pending,undefined);assert.match(row.error,/completed before cancellation/);assert.equal(row.accepted,undefined);assert.equal(f.calls.some(call=>call.body?.type==='ReviewRaster'||call.body?.type==='ImportAsset'),false);
 }finally{gate.resolve();await preparing;}
});
test('Close retains file and control owners until the exact cancellation response drains',async()=>{
 const f=fixture(),gate=deferred(),cancelGate=deferred();f.context.blockedType='PrepareRaster';f.context.commandGate=gate;f.context.cancelGate=cancelGate;f.context.cancelCompleted=true;
 const preparing=f.controller.select([file('first.png')]);let closing;
 try{await reached(()=>!!f.context.activeCommand);let closed=false;closing=f.controller.releaseDocument().then(()=>{closed=true;});await reached(()=>f.context.cancelCalls.length===1);gate.resolve();await Promise.resolve();assert.equal(closed,false);assert.equal(f.controller.inspect().files,1);assert(allocations().cpuBytes>0);
  cancelGate.resolve();await preparing;await closing;assert.equal(closed,true);assert.equal(f.controller.inspect().pendingOperations,0);assert.equal(f.controller.inspect().files,0);assert.equal(allocations().cpuBytes,0);assert.equal(f.context.cancelCalls.length,1);
 }finally{cancelGate.resolve();gate.resolve();await preparing;await closing;}
});

test('owned command responses stay admitted through delayed inspection read and actual Close drain',async()=>{
 const f=fixture(),gate=deferred(),read=f.editor.ownedJSON;let reading=false;f.editor.ownedJSON=async function(path,...args){if(path.includes('/raster-import-inspections/')){reading=true;await gate.promise;}return read.call(this,path,...args);};
 const preparing=f.controller.select([file('owned.png')]);let closing;try{await reached(()=>reading);const response=f.responseOwners.find(value=>value.kind==='InspectRasterOriginal');assert(response);assert.equal(response.released,false);assert(allocations().cpuBytes>0);let closed=false;closing=f.controller.releaseDocument().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);assert.equal(response.released,false);gate.resolve();await preparing;await closing;assert.equal(response.released,true);assert(f.responseOwners.every(value=>value.released));assert.equal(f.calls.some(call=>call.body?.type==='PrepareRaster'),false);}finally{gate.resolve();await preparing;await closing;}
});
test('upload metadata and accepted row facts are independent copies before command response release',async()=>{
 const f=fixture();await f.controller.select([file('owned.png')]);const row=f.controller.rows[0],stage=structuredClone(row.stage),raster=structuredClone(row.raster),review=structuredClone(row.prepared);assert(f.responseOwners.every(value=>value.released));for(const response of f.responseOwners){if(response.kind==='upload')response.value.stagingId='mutated';for(const event of Array.isArray(response.value)?response.value:[]){if(event.payload?.asset){event.payload.asset.id='mutated';if(event.payload.asset.raster)event.payload.asset.raster.width=0;}if(event.payload?.reviewId)event.payload.reviewId='mutated';}}
 assert.deepEqual(row.stage,stage);assert.deepEqual(row.raster,raster);assert.deepEqual(row.prepared,review);f.ready();f.controller.selectItem(row.id,true);await f.controller.apply();assert.equal(row.state,'applied');assert(f.responseOwners.every(value=>value.released));
});
test('owned original retry response releases after reconciling its accepted import exactly once',async()=>{const f=fixture();await f.controller.select([file('retry-owned.png')]);f.ready();const row=f.controller.rows[0];f.controller.selectItem(row.id,true);f.context.interruptImport=true;await f.controller.apply();assert.equal(row.state,'uncertain');await f.controller.retry(row.id);assert.equal(row.state,'applied');assert.equal(f.responseOwners.filter(value=>value.kind==='retry').length,1);assert(f.responseOwners.every(value=>value.released));assert.equal(f.calls.filter(call=>call.body?.type==='ImportAsset').length,1);});
test('owned cancellation receipt releases after exact preparation status is consumed',async()=>{const f=fixture(),gate=deferred();f.context.blockedType='PrepareRaster';f.context.commandGate=gate;const preparing=f.controller.select([file('cancel-owned.png')]);try{await reached(()=>!!f.context.activeCommand);await f.controller.cancelItem(f.controller.rows[0].id);await preparing;assert.equal(f.controller.rows[0].state,'cancelled');const response=f.responseOwners.find(value=>value.kind==='cancel');assert(response);assert.equal(response.released,true);assert(f.responseOwners.every(value=>value.released));}finally{gate.resolve();await preparing;}});
test('a refused owned upload metadata copy releases its response and retains the original row for retry',async()=>{const f=fixture(),upload=f.editor.upload;f.editor.upload=async function(...args){return {...await upload.apply(this,args),unexpected:'x'.repeat(9000)};};await f.controller.select([file('refused.png')]);const row=f.controller.rows[0];assert.equal(row.state,'failed');assert.equal(row.stage,undefined);assert.equal(row.file.name,'refused.png');assert.equal(f.calls.some(call=>call.body),false);assert(f.responseOwners.every(value=>value.released));});

test('Stop racing an owned upload return retains the exact completed stage for original retry',async()=>{const f=fixture(),upload=f.editor.ownedUpload;f.editor.ownedUpload=async function(...args){const result=await upload.apply(this,args);f.controller.stop();return result;};await f.controller.select([file('completed-stage.png')]);const row=f.controller.rows[0],response=f.responseOwners.find(value=>value.kind==='upload');assert.equal(row.state,'cancelled');assert.equal(row.stage.stagingId,'completed-stage.png');assert.equal(response.released,true);response.value.stagingId='changed-after-release';assert.equal(row.stage.stagingId,'completed-stage.png');assert.equal(f.calls.some(call=>call.body),false);await f.controller.retry(row.id);assert.equal(row.state,'ready');assert.equal(f.calls.filter(call=>call.type==='upload').length,1);assert.equal(f.calls.find(call=>call.body?.type==='FinalizeStaging').body.stagingId,'completed-stage.png');assert(f.responseOwners.every(value=>value.released));});

// Exercise the actual rendered upload handler and its settled-event adapter.
// The public control stages files before dispatch and rolls them back on veto.
function uploadChange(f,{files,previous=f.controller.rows.flatMap(row=>row.file?[row.file]:[]),reason='remove',veto=false,proposed=files}){
 const view=f.controller.render(),index=view.strings.findIndex(text=>text.endsWith('@en-change='));assert(index>=0);const handler=view.values[index],control={files,isConnected:true};
 const event={currentTarget:control,detail:Object.freeze({previous,proposed,reason}),defaultPrevented:false,composedPath:()=>[control]};handler(event);event.currentTarget=null;
 if(veto){event.defaultPrevented=true;control.files=previous;}
 return {control,event};
}
test('explicit last failed-file Remove clears the row only after its exact File lease reaches render commit',async()=>{
 const f=fixture();f.context.failName='bad.png';const input=file('bad.png');await f.controller.select([input]);const row=f.controller.rows[0],before=allocations(),gate=deferred(),calls=f.calls.length;assert.equal(row.state,'failed');f.host.updateComplete=gate.promise;
 try{uploadChange(f,{files:[]});await reached(()=>f.controller.rows.length===0);assert.equal(f.controller.inspect().files,1);assert.equal(row.file,input);assert.equal(allocations().cpuBytes,before.cpuBytes);assert.equal(allocations().handles,before.handles);assert.equal(f.calls.length,calls);
  gate.resolve();await reached(()=>!f.controller.task);assert.equal(f.controller.inspect().files,0);assert.equal(row.file,undefined);assert.equal(allocations().cpuBytes,before.cpuBytes-131072);assert.equal(allocations().handles,before.handles-2);assert.equal(f.controller.destination,'current');
 }finally{gate.resolve();f.host.updateComplete=Promise.resolve();}
});
test('empty chooser cancellation and a later veto of last-file Remove preserve the failed row',async()=>{
 const f=fixture();f.context.failName='bad.png';const input=file('bad.png');await f.controller.select([input]);const row=f.controller.rows[0],before=allocationResources(),calls=f.calls.length;
 uploadChange(f,{files:[],reason:'select'});await Promise.resolve();await Promise.resolve();assert.equal(f.controller.rows[0],row);assert.equal(row.file,input);assert.deepEqual(allocationResources(),before);
 const vetoed=uploadChange(f,{files:[],veto:true});await Promise.resolve();await Promise.resolve();assert.deepEqual(vetoed.control.files,[input]);assert.equal(f.controller.rows[0],row);assert.equal(f.controller.inspect().files,1);assert.equal(f.calls.length,calls);
});
test('Remove distinguishes same-name Files and preserves neighbour review, selection, receipt and destination identities',async()=>{
 const f=fixture(),first=file('same.png'),second=file('same.png'),third=file('done.png');await f.controller.select([first,second,third]);f.ready();f.controller.selectItem(f.controller.rows[2].id,true);await f.controller.apply();const [removed,kept,accepted]=f.controller.rows;f.controller.selectItem(kept.id,true);
 const prepared=kept.prepared,url=kept.url,target=f.controller.target,receipt=accepted.accepted,owner=f.controller.owner,calls=f.calls.length;uploadChange(f,{files:[second]});await reached(()=>!f.controller.rows.includes(removed)&&!f.controller.task);
 assert.deepEqual(f.controller.rows,[kept,accepted]);assert.equal(kept.file,second);assert.equal(kept.prepared,prepared);assert.equal(kept.url,url);assert.equal(kept.selected,true);assert.equal(kept.loaded,true);assert.equal(accepted.accepted,receipt);assert.equal(accepted.state,'applied');assert.equal(f.controller.target,target);assert.equal(f.controller.owner,owner);assert.equal(f.calls.length,calls);assert.equal(removed.file,undefined);assert.equal(urls.has(url),true);
});
test('stale, reordered or substituted Remove proposals restore the authoritative exact File list',async()=>{
 const f=fixture(),first=file('one.png'),second=file('two.png'),third=file('three.png');await f.controller.select([first,second,third]);const rows=[...f.controller.rows],calls=f.calls.length;
 for(const proposal of [{files:[first,third],previous:[first,file('two.png'),third]},{files:[third,first]},{files:[first,file('three.png')]},{files:[first,third],proposed:[second,third]}]){const {control}=uploadChange(f,proposal);await reached(()=>control.files.length===3);assert.deepEqual(control.files,[first,second,third]);assert.deepEqual(f.controller.rows,rows);}
 assert.equal(f.calls.length,calls);
});
test('Remove cannot discard an in-flight preparation or its exact cancellation and original delivery identities',async()=>{
 const f=fixture(),gate=deferred(),cancelGate=deferred();f.context.blockedType='PrepareRaster';f.context.commandGate=gate;f.context.cancelGate=cancelGate;const first=file('first.png'),second=file('second.png'),preparing=f.controller.select([first,second]);
 try{await reached(()=>!!f.context.activeCommand);const [row,next]=f.controller.rows,id=row.pending.id;const during=uploadChange(f,{files:[second]});await reached(()=>during.control.files.length===2);assert.equal(row.pending.id,id);assert.deepEqual(f.controller.rows,[row,next]);assert.equal(f.context.cancelCalls.length,0);
  const canceling=f.controller.cancelItem(row.id);await reached(()=>f.context.cancelCalls.length===1);const cancelling=uploadChange(f,{files:[second]});await reached(()=>cancelling.control.files.length===2);assert.equal(row.pending.id,id);assert(row.cancellation);assert.equal(row.file,first);cancelGate.resolve();await canceling;await preparing;assert.equal(row.state,'cancelled');assert.equal(next.state,'ready');assert.deepEqual(f.context.cancelCalls.map(value=>value.id),[id]);
 }finally{cancelGate.resolve();gate.resolve();await preparing;}
});
test('uncertain original delivery and changed document owner refuse Remove without dropping their rows',async()=>{
 const f=fixture();await f.controller.select([file('uncertain.png')]);f.ready();const row=f.controller.rows[0];f.controller.selectItem(row.id,true);f.context.interruptImport=true;await f.controller.apply();const pending=row.pending.id;assert.equal(row.state,'uncertain');const unresolved=uploadChange(f,{files:[]});await reached(()=>unresolved.control.files.length===1);assert.equal(row.pending.id,pending);assert.equal(f.controller.rows[0],row);
 await f.controller.retry(row.id);await f.controller.select([file('owner.png')]);const owned=f.controller.rows[0];f.editor.documentEpoch++;const stale=uploadChange(f,{files:[]});await reached(()=>stale.control.files.length===1);assert.equal(f.controller.rows[0],owned);assert.equal(owned.file,stale.control.files[0]);
});
test('stopped settled rows remain removable and Close drains a concurrent removal commit exactly once',async()=>{
 const f=fixture();await f.controller.select([file('stopped.png')]);f.controller.stop();const row=f.controller.rows[0],gate=deferred();f.host.updateComplete=gate.promise;let closing;
 try{uploadChange(f,{files:[]});await reached(()=>f.controller.rows.length===0);let closed=false;closing=f.controller.releaseDocument().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);assert.equal(row.file.name,'stopped.png');assert.equal(f.controller.inspect().files,1);gate.resolve();await closing;assert.equal(row.file,undefined);assert.equal(f.controller.inspect().files,0);assert.equal(f.controller.inspect().pendingOperations,0);assert.equal(allocations().cpuBytes,0);
 }finally{gate.resolve();f.host.updateComplete=Promise.resolve();await closing;}
});
test('a failed removal render retains the exact File and lease until a successful Close retry',async()=>{
 const f=fixture();f.context.failName='bad.png';const input=file('bad.png');await f.controller.select([input]);const row=f.controller.rows[0],before=allocationResources();f.host.updateComplete=Promise.reject(Error('remove render failed'));
 try{uploadChange(f,{files:[]});await reached(()=>f.controller.rows.length===0&&!f.controller.task);assert.match(f.controller.error,/remove render failed/);assert.equal(row.file,input);assert.equal(f.controller.inspect().files,1);assert.equal(f.controller.inspect().cleanupFailures,1);assert.deepEqual(allocationResources(),before);}
 finally{f.host.updateComplete=Promise.resolve();await f.controller.releaseDocument();}
 assert.equal(row.file,undefined);assert.equal(f.controller.inspect().files,0);assert.equal(allocations().cpuBytes,0);
});

test('ordinary chooser replacement still reports its render failure after its intentional epoch change',async()=>{
 const f=fixture(),input=file('kept.png');await f.controller.select([input]);const row=f.controller.rows[0],epoch=f.controller.epoch;f.host.updateComplete=Promise.reject(Error('chooser replacement render failed'));
 try{uploadChange(f,{files:[file('replacement.png')],reason:'select'});await reached(()=>f.controller.error.includes('chooser replacement render failed'));assert(f.controller.epoch>epoch);assert.equal(row.file,input);assert.equal(f.controller.inspect().files,1);assert.equal(f.calls.filter(call=>call.type==='upload').length,1);}
 finally{f.host.updateComplete=Promise.resolve();await f.controller.releaseDocument();}
 assert.equal(f.controller.inspect().files,0);assert.equal(allocations().cpuBytes,0);
});

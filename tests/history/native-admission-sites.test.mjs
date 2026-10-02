import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transformWithOxc} from 'vite';

// Execute the exact production methods. SQLite, native workers and their
// transport are boundary doubles; admission and History's catch/finally are
// never substituted. These cases are correctness evidence, not RSS measurements.
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const compile=async(source,name)=>(await transformWithOxc(source,name)).code;
const read=path=>readFile(path,'utf8');
function between(source,start,end){
 const first=source.indexOf(start),last=source.indexOf(end,first);
 assert(first>=0&&last>first,'Expected actual method boundaries: '+start);
 assert.equal(source.indexOf(start,first+start.length),-1,'Method must be unique');
 return source.slice(first,last);
}
const errors=await import(data(await compile(await read('server/storage/errors.ts'),'errors.ts')));
const {StoreError}=errors;
const assets=await read('server/storage/assets.ts');
const {AssetRejection}=await import(data(await compile(between(assets,'export class AssetRejection extends Error','type StoredStage'),'asset-rejection.ts')));
const diagnosticURL=data(await compile(await read('src/observability/diagnostic-memory.ts'),'diagnostic-memory.ts'));
let serverDiagnostic=await compile(await read('server/observability/diagnostic-memory.ts'),'server-diagnostic-memory.ts');
serverDiagnostic=serverDiagnostic.replaceAll("'../../src/observability/diagnostic-memory.js'",JSON.stringify(diagnosticURL)).replaceAll('"../../src/observability/diagnostic-memory.js"',JSON.stringify(diagnosticURL));
const {DiagnosticRing}=await import(data(serverDiagnostic));
const rasterCoreURL=data(await compile(await read('src/raster/core.ts'),'raster-core.ts'));
let rasterResourcePlan=await compile(await read('server/raster/resource-plan.ts'),'raster-resource-plan.ts');
rasterResourcePlan=rasterResourcePlan.replaceAll("'../../src/raster/core.js'",JSON.stringify(rasterCoreURL)).replaceAll('"../../src/raster/core.js"',JSON.stringify(rasterCoreURL));
const {retainedTextResourcePlan,compositionResourcePlan}=await import(data(rasterResourcePlan));
const rasterMethod=between(await read('server/storage/raster.ts'),'  private async compute(','  rasterWorkerState()');
const historyMethod=between(await read('server/storage/history.ts'),'  private async prepare(id:string,slot:string){','  page(documentId:string,after:string,kind:');
async function harness(method,name,names){
 const source='export function bind(dependencies){const {'+names.join(',')+'}=dependencies;return class Subject {\n'+method+'\n};}';
 return (await import(data(await compile(source,name)))).bind;
}
const rasterHarness=await harness(rasterMethod,'raster-admission-harness.ts',['StoreError','AssetRejection','process','setInterval','clearInterval','sanitizePhaseContext','retainedTextResourcePlan','compositionResourcePlan']);
const historyHarness=await harness(historyMethod,'history-admission-harness.ts',['StoreError','AssetRejection','TextTreatmentError','RequestError','CompositionError','Buffer','performance','structuredClone','setImmediate','randomUUID','canonical','semanticDigest']);
function observed(t,name){
 const ring=new DiagnosticRing(name,32,16384);
 t.after(()=>ring.dispose());
 return {ring,rows(){const read=ring.read();try{return structuredClone(read.value);}finally{read.release();}}};
}
const LIMIT=512*1024**2,PREFLIGHT=128*1024**2,EXTERNAL=64495692;
function rasterFixture(t,{rss=LIMIT-PREFLIGHT-EXTERNAL,external=EXTERNAL,warm=false,beforeAdmission=()=>{}}={}){
 const logs=observed(t,'diagnostic-admission-sites-raster'),timers=new Set(),disk=new Map(),calls=[];
 const Subject=rasterHarness({StoreError,AssetRejection,retainedTextResourcePlan,compositionResourcePlan,process:{memoryUsage:()=>({rss})},setInterval(fn){const timer={fn};timers.add(timer);return timer;},clearInterval(timer){assert(timers.delete(timer));},sanitizePhaseContext:value=>value});
 // This is the worker transport double, not a forged token passed to a real
 // owner. worker-owner.test.mjs separately exercises actual lease authority.
 const readyWorker=warm?Object.freeze({generation:1,threadId:1,startedMs:1,clockOriginUnixMs:1700000000000}):null;
 const owner=Object.assign(new Subject(),{reservedCPU:0,externalCPU:()=>external,observations:logs.ring,importCancellations:new Map(),objects:{reserve(id,bytes){disk.set(id,bytes);},capacity(){},},workerOwner:{readyIdentity:readyWorker,snapshot:{identity:{generation:1,threadId:1}},async run(job,slot,hooks,requiredReadyWorker){calls.push({job,slot,requiredReadyWorker});assert.equal(requiredReadyWorker,job.type==='text'||job.type==='compose'?readyWorker??undefined:undefined);hooks.check();beforeAdmission(job);const plan=job.type==='text'?retainedTextResourcePlan(job.width,job.height):job.type==='compose'?compositionResourcePlan(job.width,job.height,job.layers,job.inputs,!!job.requestSource):{cpuBytes:117506048,diskBytes:2100224};hooks.admit(plan);return {metrics:{},plan};},async interrupt(){throw Error('Unexpected interruption');}},retainWorkerPhases(){throw Error('Unexpected worker telemetry');}});
 t.after(()=>assert.equal(timers.size,0,'Actual compute finally must clear its supervisor'));
 return {owner,calls,disk,timers,readyWorker,rows:logs.rows,setRSS(value){rss=value;},setExternal(value){external=value;},job:{type:'text',width:16,height:16,directory:'/fixture',path:'/fixture/pixels',source:{},dependencies:[]},slot:'history:native-admission-case'};
}

test('one byte above the exact raster ceiling records refusal before worker or reservation ownership',async t=>{
 const f=rasterFixture(t,{rss:LIMIT-PREFLIGHT-EXTERNAL+1});f.owner.reservedCPU=73;
 await assert.rejects(f.owner.compute(f.job,f.slot,()=>{}),error=>error instanceof StoreError&&error.code==='CAPACITY');
 assert.equal(f.calls.length,0);assert.equal(f.timers.size,0);assert.equal(f.disk.size,0);assert.equal(f.owner.reservedCPU,73);assert.equal(f.owner.importCancellations.size,0);
 assert.deepEqual(f.rows(),[{phase:'resource-preflight',slot:f.slot,job:'text',processRSS:LIMIT-PREFLIGHT-EXTERNAL+1,externalCPU:EXTERNAL,preflightCPU:PREFLIGHT,combinedReservedBytes:LIMIT+1,limit:LIMIT,admitted:false}]);
});

test('equality at the unchanged ceiling still admits and creates no refusal observation',async t=>{
 const f=rasterFixture(t);await f.owner.compute(f.job,f.slot,()=>{});
 assert.equal(f.calls.length,1);assert.equal(f.owner.reservedCPU,109119488);assert.equal(f.disk.get(f.slot),2100224n);assert.equal(f.timers.size,0);
 assert.equal(f.rows().filter(row=>row.phase==='resource-preflight').length,0);assert.equal(f.rows().filter(row=>row.phase==='resource-admission').length,1);
});

test('the same history slot receives a fresh composition preflight after successful text retention',async t=>{
 const f=rasterFixture(t);await f.owner.compute(f.job,f.slot,()=>{});
 const retainedCPU=f.owner.reservedCPU,retainedDisk=f.disk.get(f.slot);f.setRSS(LIMIT-PREFLIGHT-EXTERNAL+1);
 await assert.rejects(f.owner.compute({...f.job,type:'compose',width:512,height:512,layers:[],inputs:[]},f.slot,()=>{}),{code:'CAPACITY'});
 assert.equal(f.calls.length,1);assert.equal(f.owner.reservedCPU,retainedCPU);assert.equal(f.disk.get(f.slot),retainedDisk);
 assert.equal(f.rows().at(-1).job,'compose');assert.equal(f.rows().at(-1).combinedReservedBytes,LIMIT+1);
});

test('diagnostic pressure cannot replace a raster capacity refusal or start native work',async t=>{
 const f=rasterFixture(t,{rss:LIMIT-PREFLIGHT-EXTERNAL+1});f.owner.observations={add(){throw Error('DIAGNOSTIC_BUDGET');}};
 await assert.rejects(f.owner.compute(f.job,f.slot,()=>{}),error=>error instanceof StoreError&&error.code==='CAPACITY');
 assert.equal(f.calls.length,0);assert.equal(f.disk.size,0);assert.equal(f.timers.size,0);assert.equal(f.owner.reservedCPU,0);
});

test('repeated preflight refusals remain bounded by the existing diagnostic ring',async t=>{
 const f=rasterFixture(t,{rss:LIMIT-PREFLIGHT-EXTERNAL+1});
 for(let i=0;i<40;i++)await assert.rejects(f.owner.compute(f.job,'history:refusal-'+i,()=>{}),{code:'CAPACITY'});
 assert.equal(f.rows().length,32);assert.equal(f.owner.observations.dropped,8);assert.equal(f.rows()[0].slot,'history:refusal-8');assert.equal(f.rows().at(-1).slot,'history:refusal-39');
 assert.equal(f.calls.length,0);assert.equal(f.disk.size,0);assert.equal(f.timers.size,0);
});

for(const excess of [0,1])test('ready retained-text diagnostic admission at the exact ceiling plus '+excess+' byte',async t=>{
 const cpuBytes=109119488,rss=LIMIT-cpuBytes-EXTERNAL+excess,f=rasterFixture(t,{rss,warm:true});f.owner.reservedCPU=73;
 assert.equal(retainedTextResourcePlan(16,16).cpuBytes,cpuBytes);
 if(excess){
  await assert.rejects(f.owner.compute(f.job,f.slot,()=>{}),{code:'CAPACITY'});
  assert.deepEqual(f.rows(),[{phase:'resource-preflight',slot:f.slot,job:'text',processRSS:rss,externalCPU:EXTERNAL,preflightCPU:cpuBytes,combinedReservedBytes:LIMIT+1,limit:LIMIT,admitted:false}]);
  assert.equal(f.calls.length,0);assert.equal(f.disk.size,0);assert.equal(f.owner.reservedCPU,73);
 }else{
  const result=await f.owner.compute(f.job,f.slot,()=>{}),rows=f.rows();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].requiredReadyWorker,f.readyWorker);
  assert.equal(rows.length,1);assert.equal(rows[0].phase,'resource-admission');assert.equal(rows[0].replacedCPU,cpuBytes);
  assert.deepEqual(rows[0].plan,retainedTextResourcePlan(16,16));assert.equal(rows[0].combinedReservedBytes,LIMIT);assert.equal(rows[0].admitted,true);
  assert.equal(result.metrics.combinedReservedBytes,LIMIT);assert.equal(f.owner.reservedCPU,cpuBytes);assert.equal(f.disk.get(f.slot),2100224n);
 }
 assert.equal(f.timers.size,0);assert.equal(f.owner.importCancellations.size,0);
});

for(const changedOwner of ['rss','external'])test('ready retained-text plan arrival rechecks a one-byte '+changedOwner+' increase',async t=>{
 const cpuBytes=109119488,rss=LIMIT-cpuBytes-EXTERNAL;
 const f=rasterFixture(t,{rss,warm:true,beforeAdmission(){if(changedOwner==='rss')f.setRSS(rss+1);else f.setExternal(EXTERNAL+1);}});
 await assert.rejects(f.owner.compute(f.job,f.slot,()=>{}),{code:'CAPACITY'});
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].requiredReadyWorker,f.readyWorker);assert.equal(f.disk.size,0);assert.equal(f.timers.size,0);
 const rows=f.rows();assert.equal(rows.length,1);const row=rows[0];assert.equal(row.phase,'resource-admission');assert.equal(row.replacedCPU,cpuBytes);assert.equal(row.plan.cpuBytes,cpuBytes);assert.equal(row.combinedReservedBytes,LIMIT+1);assert.equal(row.admitted,false);
 assert.equal(row.processRSS,rss+(changedOwner==='rss'?1:0));assert.equal(row.externalCPU,EXTERNAL+(changedOwner==='external'?1:0));assert.equal(f.owner.reservedCPU,cpuBytes);
});

test('an idle ready worker does not change unrelated decode startup preflight',async t=>{
 const rss=LIMIT-PREFLIGHT-EXTERNAL+1,f=rasterFixture(t,{rss,warm:true});
 await assert.rejects(f.owner.compute({...f.job,type:'decode'},f.slot,()=>{}),{code:'CAPACITY'});
 assert.equal(f.calls.length,0);assert.equal(f.disk.size,0);assert.equal(f.owner.reservedCPU,0);
 assert.equal(f.rows().at(-1).preflightCPU,PREFLIGHT);assert.equal(f.rows().at(-1).combinedReservedBytes,LIMIT+1);
});

const composeJob=()=>({type:'compose',directory:'/fixture',width:512,height:512,
 layers:[{assetId:'text',transform:[1,0,0,1,0,0],opacity:1,mask:null}],
 inputs:[{id:'text',path:'/fixture/pixels',info:{width:16,height:16,role:'composite'}}],dependencies:[]});

for(const excess of [0,1])test('ready composition admits its complete source-row plan at the exact ceiling plus '+excess+' byte',async t=>{
 const cpuBytes=117507072,rss=LIMIT-cpuBytes-EXTERNAL+excess,f=rasterFixture(t,{rss,warm:true}),job=composeJob();f.owner.reservedCPU=73;
 assert.equal(compositionResourcePlan(job.width,job.height,job.layers,job.inputs).cpuBytes,cpuBytes);
 if(excess){
  await assert.rejects(f.owner.compute(job,f.slot,()=>{}),{code:'CAPACITY'});
  assert.deepEqual(f.rows(),[{phase:'resource-preflight',slot:f.slot,job:'compose',processRSS:rss,externalCPU:EXTERNAL,preflightCPU:cpuBytes,combinedReservedBytes:LIMIT+1,limit:LIMIT,admitted:false}]);
  assert.equal(f.calls.length,0);assert.equal(f.disk.size,0);assert.equal(f.owner.reservedCPU,73);
 }else{
  const result=await f.owner.compute(job,f.slot,()=>{}),rows=f.rows();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].requiredReadyWorker,f.readyWorker);
  assert.equal(rows.length,1);assert.equal(rows[0].phase,'resource-admission');assert.equal(rows[0].replacedCPU,cpuBytes);
  assert.deepEqual(rows[0].plan,compositionResourcePlan(512,512,job.layers,job.inputs));assert.equal(rows[0].combinedReservedBytes,LIMIT);assert.equal(rows[0].admitted,true);
  assert.equal(result.metrics.combinedReservedBytes,LIMIT);assert.equal(f.owner.reservedCPU,cpuBytes);assert.equal(f.disk.get(f.slot),5242880n);
 }
 assert.equal(f.timers.size,0);assert.equal(f.owner.importCancellations.size,0);
});

test('cold composition keeps its startup reservation even when the operation plan would fit',async t=>{
 const f=rasterFixture(t,{rss:LIMIT-PREFLIGHT-EXTERNAL+1}),job=composeJob();
 assert(LIMIT-PREFLIGHT-EXTERNAL+1+EXTERNAL+compositionResourcePlan(512,512,job.layers,job.inputs).cpuBytes<LIMIT);
 await assert.rejects(f.owner.compute(job,f.slot,()=>{}),{code:'CAPACITY'});
 assert.equal(f.calls.length,0);assert.equal(f.owner.reservedCPU,0);assert.equal(f.disk.size,0);
 assert.equal(f.rows().at(-1).preflightCPU,PREFLIGHT);assert.equal(f.rows().at(-1).combinedReservedBytes,LIMIT+1);
});

for(const changedOwner of ['rss','external','source-row','mask-row','capture'])test('ready composition independently rechecks changed '+changedOwner+' at worker admission',async t=>{
 const job=composeJob();job.layers[0].mask={assetId:'mask'};job.inputs.push({id:'mask',path:'/fixture/mask',info:{width:16,height:16,role:'mask'}});
 const initial=compositionResourcePlan(512,512,job.layers,job.inputs),rss=LIMIT-initial.cpuBytes-EXTERNAL;
 const f=rasterFixture(t,{rss,warm:true,beforeAdmission(actual){
  if(changedOwner==='rss')f.setRSS(rss+1);
  else if(changedOwner==='external')f.setExternal(EXTERNAL+1);
  else if(changedOwner==='source-row')actual.inputs[0].info.width++;
  else if(changedOwner==='mask-row')actual.inputs[1].info.width++;
  else actual.requestSource={schemaVersion:1};
 }});
 await assert.rejects(f.owner.compute(job,f.slot,()=>{}),{code:'CAPACITY'});
 const executed=f.calls[0].job,current=compositionResourcePlan(512,512,executed.layers,executed.inputs,!!executed.requestSource),row=f.rows().at(-1);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].requiredReadyWorker,f.readyWorker);
 assert.equal(f.rows().length,1);assert.equal(row.phase,'resource-admission');assert.equal(row.replacedCPU,initial.cpuBytes);
 assert.deepEqual(row.plan,current);assert.equal(row.admitted,false);assert.equal(row.combinedReservedBytes,LIMIT+({'rss':1,'external':1,'source-row':64,'mask-row':32,'capture':131072}[changedOwner]));
 assert.equal(f.disk.size,0);assert.equal(f.timers.size,0);assert.equal(f.owner.reservedCPU,initial.cpuBytes);
});

test('the ready compose preflight refuses invalid extent and layer count before transport or reservation ownership',async t=>{
 for(const mutation of [job=>{job.width=0;},job=>{job.layers=Array(101).fill(job.layers[0]);}]){
  const f=rasterFixture(t,{warm:true}),job=composeJob();mutation(job);
  await assert.rejects(f.owner.compute(job,f.slot,()=>{}),/RASTER_EXTENT|RASTER_LAYERS/);
  assert.equal(f.calls.length,0);assert.equal(f.disk.size,0);assert.equal(f.owner.reservedCPU,0);assert.equal(f.timers.size,0);
 }
});

const ref=name=>({hash:'sha256:'+createHash('sha256').update(name).digest('hex'),byteLength:'16',mediaType:'application/json'});
function historyFixture(t,stage,error=new StoreError('CAPACITY')){
 const logs=observed(t,'diagnostic-admission-sites-history'),proofs=new Map(),released=[],paused=[],commits=[],steps=[];
 const original=ref('before'),source={schemaVersion:1,text:{fonts:[]},render:{pixels:ref('pixels'),width:16,height:16}};
 const body={type:'CreateTextLayer',candidate:ref('candidate'),layerId:'new-layer',name:'Authored',draft:{sessionId:'session',draftId:'draft',generation:'1'}},command={commandId:'native-command',documentId:'document',clientId:'client',expectedDocumentRevision:'1',body};
 const document={id:'document',revision:'1',branchId:'branch',historyHead:'head',width:512,height:512,image:{state:original,semanticDigest:'before',compositeAssetId:null}},before={schemaVersion:1,width:512,height:512,layers:[]};
 let nextProof=0,nextMetadata=0,finished=false;
 const fail=name=>{steps.push(name);if(name===stage)throw error;};
 class TextTreatmentError extends Error{}class RequestError extends Error{}class CompositionError extends Error{}
 const Subject=historyHarness({StoreError,AssetRejection,TextTreatmentError,RequestError,CompositionError,Buffer,performance,structuredClone,setImmediate,randomUUID:()=> 'generated-id',canonical:JSON.stringify,semanticDigest:()=> 'after'});
 const owner=Object.assign(new Subject(),{
  observations:logs.ring,closing:false,authorities:new Map([['native-command',{}]]),encodedAcceptances:new Map(),encodedReviewProofs:{discard(){throw Error('Unexpected encoded cleanup');}},
  pending:()=>({command,operationId:'operation'}),check(){},document:()=>document,assertCommand:()=>undefined,authority:()=>({}),versionState:()=>before,usedLayer(){fail('native-state');return false;},child:()=>null,patch:()=>({kind:'patch'}),barrier(){},register(){},edit(){fail('non-native-edit');return before;},
  db:{prepare(sql){return {get(){if(sql.startsWith('SELECT original'))return {original:'{}'};if(sql.startsWith('SELECT id FROM commands'))return finished?{id:'native-command'}:undefined;throw Error('Unexpected SQL read: '+sql);},run(){return {changes:1};}};}},
  objects:{
   putMetadataInSlot(bytes){const value=JSON.parse(Buffer.from(bytes).toString());if(value.render)fail('source-metadata');else if(value.layers)fail('state-metadata');else if(value.kind==='patch')fail('patch-metadata');return ref('metadata'+(++nextMetadata));},
   async prove(value){if(value===original)fail('dependency-proofs');const token='proof'+(++nextProof);proofs.set(token,value);return token;},
   proven(value,token){assert.equal(proofs.get(token),value);},releaseProof(token){assert(proofs.delete(token),'A proof must be released exactly once');released.push(token);},
   proofInventory(){return {pending:0,retained:proofs.size,activeReaders:0,metadataBytes:proofs.size*2048};},reservationInventory(){return {reservedBytes:'2625280',activeTransfers:1};},
   leaseIdentity(){throw Error('Diagnostics must not materialize owner identifiers');},
  },
  texts:{async candidate(){fail('candidate');return {source};},limits(){fail('native-limits');},fence(){}},
  rasters:{async prepareDocument(value){fail(value.type==='RetainText'?'retain-text':'composite');return {asset:{id:value.type==='RetainText'?'text-asset':'composite-asset',blob:ref('blob'),dependencies:[],availability:'available'},proofs:[]};}},
  ui:{applied(){},reconcile(){}},
  commit(bytes,build){if(stage==='commit'&&!finished){fail('commit');}try{const value=build(document,'2');commits.push({accepted:true,value});finished=true;}catch(caught){if(!(caught instanceof AssetRejection))throw caught;commits.push({accepted:false,error:caught});finished=true;}},
  pause(id){paused.push(id);},
 });
 t.after(()=>assert.equal(proofs.size,0,'Actual History finally must release acquired proofs'));
 return {owner,command,proofs,released,paused,commits,steps,rows:logs.rows};
}

for(const stage of ['candidate','source-metadata','retain-text','native-state','native-limits','state-metadata','dependency-proofs','composite','patch-metadata','commit'])test('History reports exact native '+stage+' refusal without changing pause or proof cleanup',async t=>{
 const f=historyFixture(t,stage);await f.owner.prepare(f.command.commandId,'history:'+f.command.commandId);
 assert(f.steps.includes(stage),'Failure must originate at the requested actual method boundary');assert.deepEqual(f.paused,[f.command.commandId]);assert.equal(f.commits.length,0);assert.equal(f.proofs.size,0);
 const row=f.rows().at(-1);assert.equal(row.commandId,f.command.commandId);assert.equal(row.operation,'CreateTextLayer');assert.equal(row.error,'CAPACITY');assert.equal(row.nativeStage,stage);
 assert.deepEqual(Object.keys(row.proofs).sort(),['activeReaders','metadataBytes','pending','retained']);assert.equal(row.proofs.metadataBytes,row.proofs.retained*2048);
 assert.deepEqual(row.io,{reservedBytes:'2625280',activeTransfers:1});assert(Buffer.byteLength(JSON.stringify(row))<1024,'Diagnostic is fixed scalar inventory, not a retained identity graph');
});

test('terminalizable text rejection retains its exact reason and does not become a resource pause',async t=>{
 const error=new AssetRejection('CAPACITY','TEXT_VERIFICATION_CAPACITY'),f=historyFixture(t,'candidate',error);
 await f.owner.prepare(f.command.commandId,'history:'+f.command.commandId);
 assert.deepEqual(f.paused,[]);assert.equal(f.commits.length,1);assert.equal(f.commits[0].accepted,false);assert.equal(f.commits[0].error,error);
 assert.equal(f.rows().at(-1).error,'TEXT_VERIFICATION_CAPACITY');assert.equal(f.rows().at(-1).nativeStage,'candidate');assert.equal(f.proofs.size,0);
});

test('non-native preparation failures do not gain an invented native stage or inventory',async t=>{
 const f=historyFixture(t,'non-native-edit');f.command.body={type:'SetLayerProperties',layerId:'existing',layerVersion:'1',draft:null};
 await f.owner.prepare(f.command.commandId,'history:'+f.command.commandId);
 const row=f.rows().at(-1);assert.equal(row.error,'CAPACITY');assert.equal(row.operation,'SetLayerProperties');assert.equal('nativeStage'in row,false);assert.equal('proofs'in row,false);assert.equal('io'in row,false);assert.deepEqual(f.paused,[f.command.commandId]);
});

for(const boundary of ['ring','proof-inventory','io-inventory'])test('failed native '+boundary+' diagnostics preserve rejection classification and actual proof cleanup',async t=>{
 for(const terminal of [false,true]){
  const error=terminal?new AssetRejection('CAPACITY','TEXT_VERIFICATION_CAPACITY'):new StoreError('CAPACITY'),f=historyFixture(t,'retain-text',error);
  const fail=()=>{throw Error('Diagnostic fixture refusal');};
  if(boundary==='ring')f.owner.observations={add:fail};
  else if(boundary==='proof-inventory')f.owner.objects.proofInventory=fail;
  else f.owner.objects.reservationInventory=fail;
  await f.owner.prepare(f.command.commandId,'history:'+f.command.commandId);
  assert(f.steps.includes('retain-text'));assert.equal(f.released.length,1,'Source metadata proof must survive until the actual finally');assert.equal(f.proofs.size,0);
  assert.deepEqual(f.paused,terminal?[]:[f.command.commandId]);assert.equal(f.commits.length,terminal?1:0);
  if(terminal){assert.equal(f.commits[0].accepted,false);assert.equal(f.commits[0].error,error,'The original rejection must reach persistence');}
  assert.deepEqual(f.rows(),[],'A failed diagnostic must not fabricate a partial record');
 }
});

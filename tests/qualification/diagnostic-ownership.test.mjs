import {resolveAdapterUploadModules,readStagedSource} from '../adapter-upload-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {transformWithOxc} from 'vite';
const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
async function moduleURL(path,imports={},suffix=''){
 let source=(await transformWithOxc(await readStagedSource(path),path)).code;
 for(const [name,url] of Object.entries(imports))source=source.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
 return data(source+'\n// '+suffix);
}
const diagnosticURL=await moduleURL('src/observability/diagnostic-memory.ts');
const compositionURL=await moduleURL('src/observability/composition-observations.ts',{'./diagnostic-memory.js':diagnosticURL});
const allocationsURL=await moduleURL('src/observability/allocations.ts',{'./diagnostic-memory.js':diagnosticURL,'./composition-observations.js':compositionURL});
const phasesURL=await moduleURL('src/observability/phases.ts',{'./diagnostic-memory.js':diagnosticURL});
const workersURL=await moduleURL('src/observability/browser-worker-observations.ts',{'./diagnostic-memory.js':diagnosticURL,'./phases.js':phasesURL});
const navigationURL=await moduleURL('src/observability/navigation-observations.ts',{'./diagnostic-memory.js':diagnosticURL,'./phases.js':phasesURL});
const {adapterUploadURL,adapterUploadHookURL}=await resolveAdapterUploadModules({diagnosticMemoryURL:diagnosticURL,allocationsURL});
const browserURL=await moduleURL('src/observability/browser.ts',{'./navigation-observations.js':navigationURL,'./diagnostic-memory.js':diagnosticURL,'./phases.js':phasesURL,'./browser-worker-observations.js':workersURL,'./allocations.js':allocationsURL,'./composition-observations.js':compositionURL,'./adapter-upload-hook.js':adapterUploadHookURL,'./adapter-upload.js':adapterUploadURL});
const {DiagnosticMemory,DiagnosticReads,TEXT_WORKER_DIAGNOSTIC_BYTES}=await import(diagnosticURL);
const {AllocationLedger,allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL);
const {PhaseRecorder,PHASE_OPEN_SPANS}=await import(phasesURL);
const {CompositionObservations}=await import(compositionURL);
const {BrowserPhases}=await import(browserURL);
const capacity=ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes;
function ownMemory(){const ledger=new AllocationLedger(),memory=new DiagnosticMemory();memory.adopt(value=>ledger.reserve(value));return {ledger,memory};}
function copyRead(owner){const read=owner.readSnapshot();try{return structuredClone(read.value);}finally{read.release();}} // Assertion-owned runner copy, outside the product graph.

test('bootstrap owners transfer once into central capacity and later reserves share its limit',()=>{
 const ledger=new AllocationLedger(),memory=new DiagnosticMemory(),first=memory.reserve('diagnostic-bootstrap-test',1234);
 assert.equal(ledger.snapshot().cpuBytes,0);memory.adopt(value=>ledger.reserve(value));assert.equal(ledger.snapshot().cpuBytes,1234);
 const fill=ledger.reserve({owner:'diagnostic-fill',kind:'control',cpuBytes:capacity-1234});
 assert.throws(()=>memory.reserve('diagnostic-refused',1),/ALLOCATION_BUDGET/);assert.equal(ledger.snapshot().activeRecords,2);
 fill.release();first.release();first.release();assert.equal(ledger.snapshot().cpuBytes,0);assert.throws(()=>memory.adopt(value=>ledger.reserve(value)),/ALREADY_ADOPTED/);
});

test('failed bootstrap adoption rolls back actual acquired central owners and can retry',()=>{
 const ledger=new AllocationLedger(),memory=new DiagnosticMemory(),a=memory.reserve('diagnostic-first',80),b=memory.reserve('diagnostic-second',90);let calls=0;
 assert.throws(()=>memory.adopt(value=>{if(++calls===2)throw undefined;return ledger.reserve(value);}));
 assert.equal(ledger.snapshot().cpuBytes,0);assert.equal(memory.adopted,false);
 memory.adopt(value=>ledger.reserve(value));assert.equal(ledger.snapshot().cpuBytes,170);a.release();b.release();assert.equal(ledger.snapshot().cpuBytes,0);
});

test('phase capacity refuses before clock/context work and context walks only fixed own fields',()=>{
 const {ledger,memory}=ownMemory(),full=ledger.reserve({owner:'diagnostic-full',kind:'control',cpuBytes:capacity});let clock=0,getters=0;
 assert.throws(()=>new PhaseRecorder({lane:'refused',memory,now:()=>++clock}),/ALLOCATION_BUDGET/);assert.equal(clock,0);full.release();
 const recorder=new PhaseRecorder({lane:'bounded',capacity:2,memory,now:()=>1,wallNow:()=>100});
 const details=new Proxy(Object.defineProperty({bytes:2},'commandId',{get(){getters++;throw Error('getter');}}),{ownKeys(){throw Error('unbounded key enumeration');}});
 recorder.instant('ui.intent',details);assert.equal(getters,0);assert.deepEqual(copyRead(recorder).records[0].context,{bytes:2});recorder.dispose();assert.equal(ledger.snapshot().cpuBytes,0);
});

test('explicit span bound is admitted before hooks and exact maximum cannot grow retained context',()=>{
 const {ledger,memory}=ownMemory();let clocks=0;
 for(const openSpans of [0,4097,1.5,NaN])assert.throws(()=>new PhaseRecorder({lane:'span-invalid',capacity:2,openSpans,memory,now:()=>++clocks}),/PHASE_OPEN_SPANS/);
 assert.equal(clocks,0);assert.equal(ledger.snapshot().cpuBytes,0);
 const bytes=(2+2+4)*8192,fill=ledger.reserve({owner:'span-exact-fill',kind:'control',cpuBytes:capacity-bytes});
 assert.throws(()=>new PhaseRecorder({lane:'span-refused',capacity:2,openSpans:3,memory,now:()=>++clocks}),/ALLOCATION_BUDGET/);assert.equal(clocks,0);
 const recorder=new PhaseRecorder({lane:'span-exact',capacity:2,openSpans:2,memory,now:()=>1,wallNow:()=>100});fill.release();
 const first=recorder.start('ui.intent'),second=recorder.start('ui.intent');assert.equal(copyRead(recorder).invalid,0);
 const third=recorder.start('ui.intent');assert.equal(first.end(),undefined);assert.equal(second.end(),1);assert.equal(third.end(),1);assert.equal(copyRead(recorder).invalid,1);
 recorder.dispose();assert.equal(ledger.snapshot().cpuBytes,0);
 const normal=new PhaseRecorder({lane:'server-default',memory,now:()=>1,wallNow:()=>100});assert.equal(ledger.snapshot().cpuBytes,(2048+4096+4)*8192);normal.dispose();assert.equal(ledger.snapshot().cpuBytes,0);
});

test('forgotten spans are bounded tokens, evicted completions stay inert, dispose cannot resurrect data',()=>{
 const {ledger,memory}=ownMemory(),recorder=new PhaseRecorder({lane:'spans',capacity:2,memory,now:()=>2,wallNow:()=>100});
 const first=recorder.start('ui.intent',{commandId:'first'});for(let i=0;i<PHASE_OPEN_SPANS;i++)recorder.start('ui.intent',{commandId:'next-'+i});
 assert.equal(first.end(),undefined);assert.equal(copyRead(recorder).invalid,1);
 const final=recorder.start('ui.intent',{commandId:'last'});assert.equal(final.end(),2);assert.equal(typeof final.end(),'undefined');
 recorder.dispose();assert.equal(first.end(),undefined);assert.throws(()=>recorder.start('ui.intent'),/DISPOSED/);assert.equal(ledger.snapshot().cpuBytes,0);
});

test('phase copies hold real leases until release and reader limit refuses before clone',()=>{
 const {ledger,memory}=ownMemory(),recorder=new PhaseRecorder({lane:'reads',capacity:2,memory,now:()=>1,wallNow:()=>100});recorder.instant('ui.intent',{commandId:'before'});
 const baseline=ledger.snapshot().cpuBytes,reads=Array.from({length:4},()=>recorder.readSnapshot());assert(ledger.snapshot().cpuBytes>baseline);
 const native=globalThis.structuredClone;let clones=0;globalThis.structuredClone=(...args)=>{clones++;return native(...args);};
 try{assert.throws(()=>recorder.readSnapshot(),/READ_LIMIT/);assert.equal(clones,0);}finally{globalThis.structuredClone=native;}
 recorder.instant('ui.intent',{commandId:'after'});assert.equal(reads[0].value.records[0].context.commandId,'before');
 recorder.dispose();assert(ledger.snapshot().cpuBytes>0,'independent copied read survives producer disposal');
 for(const read of reads){read.release();read.release();assert.throws(()=>read.value,/RELEASED/);}assert.equal(ledger.snapshot().cpuBytes,0);
});

test('copy refusal and throwing copy preserve existing owner and release provisional booking',()=>{
 const {ledger,memory}=ownMemory(),reads=new DiagnosticReads('diagnostic-test-read',1,memory);const read=reads.read(8,()=>({fixed:1})),before=ledger.snapshot().cpuBytes;
 assert.throws(()=>reads.read(8,()=>{throw Error('not reached');}),/READ_LIMIT/);assert.deepEqual(read.value,{fixed:1});assert.equal(ledger.snapshot().cpuBytes,before);read.release();
 assert.throws(()=>reads.read(8,()=>{throw null;}));assert.equal(ledger.snapshot().cpuBytes,0);const next=reads.read(8,()=>2);next.release();
});

test('R38 diagnostics reserve control capacity without recursive prompt ownership events',()=>{
 const memory=new DiagnosticMemory(),observer=new CompositionObservations(2,()=>10,()=>100,memory),ledger=new AllocationLedger(observer);memory.adopt(value=>ledger.reserve(value));
 const initial=copyRead(observer);assert.equal(initial.cursor,0);assert.equal(initial.observerMetadata.complete,true);
 const prompt=ledger.reserve({owner:'composition-raw-read',kind:'prompt',cpuBytes:17});const read=observer.readSnapshot();
 assert.equal(read.value.cursor,1);assert.equal(read.value.promptOwnedBytes,17);assert.equal(read.value.rawInspectionOwnedBytes,17);
 assert.equal(copyRead(observer).cursor,1,'read admission is control, never a prompt observer recursion');prompt.release();read.release();
 assert.equal(copyRead(observer).cursor,2);observer.dispose();assert.equal(ledger.snapshot().cpuBytes,0);
});

test('R38 ordered ring keeps actual dropped proof, refuses getters, and stale calls do no traversal',()=>{
 const {ledger,memory}=ownMemory(),observer=new CompositionObservations(2,()=>10,()=>100,memory);observer.read('stream-read',1,1);observer.read('stream-read',2,2);observer.read('stream-read',3,3);
 let getter=0;const items=[];Object.defineProperty(items,0,{get(){getter++;throw Error('getter');},enumerable:true});observer.value('issues',items,'parse');
 const read=observer.readSnapshot();assert.equal(getter,0);assert.equal(read.value.invalid,1);assert.deepEqual(read.value.records.map(r=>r.sequence),[2,3]);assert.equal(read.value.dropped,1);read.release();
 observer.dispose();observer.value('issues',new Proxy([],{get(){throw Error('must not traverse after dispose');}}),'parse');assert.equal(ledger.snapshot().cpuBytes,0);
});

test('browser keyed acquisition recovers the exact owner, bounds readers and drops all copied graphs',()=>{
 const baseline=allocationLedger.snapshot().cpuBytes,browser=new BrowserPhases(()=>10);browser.beginAdoption({previewId:'p',commandId:'c'},false);
 const before=allocationLedger.snapshot().cpuBytes,read=browser.readSnapshot('known_key'),booked=allocationLedger.snapshot().cpuBytes;
 assert(booked>before);assert.equal(browser.readSnapshot('known_key'),read);assert.equal(allocationLedger.snapshot().cpuBytes,booked);
 const more=['two','three','four'].map(key=>browser.readSnapshot(key));assert.throws(()=>browser.readSnapshot('five'),/READ_LIMIT/);
 assert.equal(read.value.adoptions[0].context.previewId,'p');browser.dispose();assert.equal(browser.readSnapshot('known_key'),read,'cleanup can recover an existing read after producer disposal');
 read.release();for(const value of more)value.release();assert.throws(()=>read.value,/RELEASED/);assert.equal(allocationLedger.snapshot().cpuBytes,baseline);
});

const contracts=data(`export const LIMITS={deadlineMs:100000};export const frozen=v=>v;export class TextFailure extends Error{constructor(code,details){super(code);this.code=code;this.details=details;}}`);
const memoryBoundary=data(`export const engineReservationBytes=1,engineResidentBytes=1;export const planText=()=>({bytes:4,startup:4,raster:0,layout:0});export const retainPrepared=()=>{},releasePrepared=()=>{},unownedFontBytes=()=>0;export const textMemory={check(){},reserve(bytes){return{bytes,release(){}}}};`);
const textURL=await moduleURL('src/text/client.ts',{'../observability/diagnostic-memory.js':diagnosticURL,'../observability/allocations.js':allocationsURL,'../observability/browser-worker-observations.js':workersURL,'./contracts':contracts,'./memory':memoryBoundary,'./worker.ts':'http://127.0.0.1/text-worker-fixture.js'});
const {TextRenderer}=await import(textURL);
const request=()=>({text:'x',token:{documentId:'d',documentRevision:'1',layerId:'l',layerVersion:'1',sessionId:'s',generation:1},frame:{width:1,height:1},style:{primaryFont:'f',explicitFallbacks:[],sizePx:1,lineHeightMultiplier:1,fill:[0,0,0,255],align:'left',direction:'ltr'},fonts:[]});

test('real TextRenderer pre-admits diagnostics before Worker and retains delegation on terminate failure',async()=>{
 const old=globalThis.Worker,baseline=allocationLedger.snapshot().cpuBytes;let created=0,terminateFails=true;
 globalThis.Worker=class{constructor(){created++;}postMessage(){}terminate(){if(terminateFails)throw undefined;}};
 const renderer=new TextRenderer();try{const pending=renderer.prepare(request());const rejected=pending.catch(error=>error);await Promise.resolve();assert.equal(created,1);assert.equal(allocationLedger.snapshot().cpuBytes,baseline+TEXT_WORKER_DIAGNOSTIC_BYTES);
 renderer.cancel();assert.equal((await rejected).code,'TEXT_TERMINATION_FAILED');assert.equal(allocationLedger.snapshot().cpuBytes,baseline+TEXT_WORKER_DIAGNOSTIC_BYTES);assert.equal(allocationLedger.snapshot().unusedHandles,1);
 terminateFails=false;renderer.dispose();assert.equal(allocationLedger.snapshot().cpuBytes,baseline);assert.equal(allocationLedger.snapshot().unusedHandles,0);
 }finally{terminateFails=false;renderer.dispose();globalThis.Worker=old;}
});

test('real TextRenderer diagnostic refusal never constructs the native worker',async()=>{
 const old=globalThis.Worker;let created=0;globalThis.Worker=class{constructor(){created++;}};
 const baseline=allocationLedger.snapshot().cpuBytes,fill=allocationLedger.reserve({owner:'diagnostic-worker-refusal',kind:'control',cpuBytes:capacity-baseline-TEXT_WORKER_DIAGNOSTIC_BYTES+1}),renderer=new TextRenderer();
 try{await assert.rejects(renderer.prepare(request()),/ALLOCATION_BUDGET/);assert.equal(created,0);}finally{renderer.dispose();fill.release();globalThis.Worker=old;}
 assert.equal(allocationLedger.snapshot().cpuBytes,baseline);
});

test('actual text worker releases read and recorder after synchronous post failure and repeated jobs',async()=>{
 const workerDiagnostic=await moduleURL('src/observability/diagnostic-memory.ts',{},'isolated-worker-realm'),workerPhases=await moduleURL('src/observability/phases.ts',{'./diagnostic-memory.js':workerDiagnostic});
 const engine=data(`export const createTextEngine=async()=>({});export async function prepareText(request,engine,profile,phases){phases.start('text.layout',{count:1}).end();return {fixed:1};}`);
 const url=await moduleURL('src/text/worker.ts',{'../observability/diagnostic-memory.js':workerDiagnostic,'../observability/phases.js':workerPhases,'./engine':engine,'./contracts':contracts});
 const old=globalThis.self;let fail=false,success=0,errors=0;
 const scope={onmessage:null,postMessage(message){if(message.ready)return;if(fail){fail=false;throw Error('native post failure');}assert(message.phases,'phase admission remains available after previous cleanup');if(message.ok)success++;else errors++;},close(){}};globalThis.self=scope;
 try{await import(url);await Promise.resolve();fail=true;await scope.onmessage({data:{}});for(let i=0;i<20;i++)await scope.onmessage({data:{}});assert.equal(success,20);assert.equal(errors,1);}finally{globalThis.self=old;}
});

test('navigation storage admission refuses before observing and disposal releases its fixed retained owner',async()=>{
 const {NavigationObservations,NAVIGATION_OBSERVATION_BYTES}=await import(navigationURL),before=allocationLedger.snapshot();let clocks=0;
 const block=allocationLedger.reserve({owner:'navigation-admission-block',kind:'control',cpuBytes:capacity-before.cpuBytes-NAVIGATION_OBSERVATION_BYTES+1});
 try{assert.throws(()=>new NavigationObservations(()=>++clocks,1),/ALLOCATION_BUDGET/);assert.equal(clocks,0);}finally{block.release();}
 assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);const owner=new NavigationObservations(()=>++clocks,1);
 try{assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes+NAVIGATION_OBSERVATION_BYTES);owner.modelReady({sessionId:'session',generation:1,documentId:'document',revision:'1',snapshotId:'publication',assetId:'composite',assetHash:'sha256:'+'a'.repeat(64)});owner.reset();assert.equal(owner.copy(),null);}finally{owner.dispose();}
 assert.equal(allocationLedger.snapshot().cpuBytes,before.cpuBytes);assert.equal(allocationLedger.snapshot().activeRecords,before.activeRecords);assert.throws(()=>owner.copy(),/DISPOSED/);
});

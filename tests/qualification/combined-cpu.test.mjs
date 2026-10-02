import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {transformWithOxc} from 'vite';
import {isolatedDiagnosticModules} from '../owned-preview-module.mjs';

// The pool, admission rules and ledger are production sources in independent
// module graphs. The optional staged root changes the pool source only; existing
// OBSERVABILITY_STAGED_ROOT support in the shared loader selects the ledger.
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
let fixtureSerial=0;
async function moduleURL(path,replacements={},identity=''){
 const source=process.env.COMBINED_CPU_STAGED_ROOT&&path==='src/text/memory.ts'?resolve(process.env.COMBINED_CPU_STAGED_ROOT,path):path;
 let code=(await transformWithOxc(await readFile(source,'utf8'),path)).code;
 for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
 return data(code+'\n// '+identity);
}
async function fixture({bind=true,source,read,now,prepared=false}={}){
 const identity='combined-cpu-fixture-'+ ++fixtureSerial;
 const {allocationsURL,diagnosticMemoryURL}=await isolatedDiagnosticModules();
 const budgetURL=await moduleURL('src/protocol/text-budget.ts',{},identity),contractsURL=await moduleURL('src/text/contracts.ts',{},identity);
 const admissionURL=await moduleURL('src/text/admission.ts',{'./contracts':contractsURL},identity);
 const profile=JSON.parse(await readFile('src/text/profile.json','utf8'));
 const memoryURL=await moduleURL('src/text/memory.ts',{'./admission':admissionURL,'./contracts':contractsURL,'./profile.json':data('const profile='+JSON.stringify(profile)+';export default profile;export const engine=profile.engine;'),'../protocol/text-budget':budgetURL,'../observability/diagnostic-memory.js':diagnosticMemoryURL},identity);
 const memoryModule=await import(memoryURL),allocationModule=await import(allocationsURL);
 // Prepared helpers close over the real singleton. Only those observer-fault
 // cases detach its eager default owner before installing their test observer.
 const textMemory=prepared?memoryModule.textMemory:new memoryModule.MemoryPool();
 if(prepared)allocationModule.allocationLedger.observeTextReservations(()=>0);
 let time=10;
 const ledger=new allocationModule.AllocationLedger(undefined,now??(()=>++time));
 if(bind)ledger.observeTextReservations(read?()=>read(textMemory):()=>textMemory.snapshot.textBytes,source?source(textMemory):textMemory);
 return {ledger,...memoryModule,...allocationModule,textMemory};
}
const reserve=(ledger,cpuBytes)=>ledger.reserve({owner:'combined-cpu-test',kind:'scratch',cpuBytes});
const witness=ledger=>ledger.snapshot().combinedCpu.window;
function assertComplete(window,peak,current=0){
 assert.equal(window.peakBytes,peak);assert.equal(window.currentBytes,current);
 assert.equal(window.observationComplete,true);assert.equal(window.ownerCoverageComplete,false);
 assert.deepEqual(window.failures,[]);assert(window.missing.includes('native-blob-residency'));
 assert.equal(window.ledgerBytesAtPeak+window.textBytesAtPeak,peak);
}

test('synchronous pool notifications retain a transient text peak between ledger snapshots',async()=>{
 const {ledger,textMemory}=await fixture();
 ledger.beginCpuObservationWindow('transient-text');
 assert.equal(witness(ledger).currentBytes,0);
 const text=textMemory.reserve(8192);text.release();
 ledger.endCpuObservationWindow('transient-text');
 const window=witness(ledger);assertComplete(window,8192);assert.equal(window.sealed,true);
 assert.equal(window.ledgerBytesAtPeak,0);assert.equal(window.textBytesAtPeak,8192);
 assert.equal(ledger.snapshot().text.observedPeakBytes,0,'the existing sampled peak retains its original meaning');
 assert(window.peakSequence>window.startSequence);assert(window.endSequence>=window.peakSequence);
});

test('disjoint central and text peaks are never summed as a simultaneous maximum',async()=>{
 const {ledger,textMemory}=await fixture();ledger.beginCpuObservationWindow('disjoint');
 const central=reserve(ledger,900);central.release();
 const text=textMemory.reserve(600);assert.equal(ledger.snapshot().text.observedPeakBytes,600);text.release();
 ledger.endCpuObservationWindow('disjoint');
 const snapshot=ledger.snapshot();assertComplete(snapshot.combinedCpu.window,900);
 assert.equal(snapshot.peaks.cpuBytes,900);assert.equal(snapshot.text.observedPeakBytes,600);
 assert.notEqual(snapshot.combinedCpu.window.peakBytes,snapshot.peaks.cpuBytes+snapshot.text.observedPeakBytes);
 assert.equal(snapshot.peakScope,'lease-owners-only-text-observed-separately');
});

test('overlapping pool and central owners include resize peaks and actual release endpoints',async()=>{
 const {ledger,textMemory}=await fixture();ledger.beginCpuObservationWindow('overlap');
 const central=reserve(ledger,100),text=textMemory.reserve(40);
 central.resize({cpuBytes:175});assertComplete(witness(ledger),215,215);
 text.release();assertComplete(witness(ledger),215,175);
 central.resize({cpuBytes:25});assertComplete(witness(ledger),215,25);
 central.release();ledger.endCpuObservationWindow('overlap');
 const window=witness(ledger);assertComplete(window,215);assert.equal(window.ledgerBytesAtPeak,175);assert.equal(window.textBytesAtPeak,40);
});

test('a central resize peak is retained even when resized down before the next snapshot',async()=>{
 const {ledger,textMemory}=await fixture();ledger.beginCpuObservationWindow('transient-resize');
 const central=reserve(ledger,10),text=textMemory.reserve(20);
 central.resize({cpuBytes:180});central.resize({cpuBytes:5});central.release();text.release();
 ledger.endCpuObservationWindow('transient-resize');const window=witness(ledger);
 assertComplete(window,200);assert.equal(window.ledgerBytesAtPeak,180);assert.equal(window.textBytesAtPeak,20);
});

test('window boundaries include pre-existing simultaneous owners and never release ownership themselves',async()=>{
 const {ledger,textMemory}=await fixture(),central=reserve(ledger,60),text=textMemory.reserve(40);
 ledger.beginCpuObservationWindow('existing-owners');assert.equal(textMemory.snapshot.textBytes,40);
 ledger.endCpuObservationWindow('existing-owners');assert.equal(textMemory.snapshot.textBytes,40);
 const window=witness(ledger);assertComplete(window,100,100);assert.equal(ledger.snapshot().activeRecords,1);
 central.release();text.release();assert.equal(ledger.snapshot().cpuBytes,0);assert.deepEqual(witness(ledger),window);
});

test('failed admission is atomic and double release emits no extra pool mutation',async()=>{
 const {ledger,textMemory,ALLOCATION_LIMITS:L}=await fixture();ledger.beginCpuObservationWindow('failed-admission');
 const central=reserve(ledger,L.cpuBytes-L.textPartitionBytes),text=textMemory.reserve(L.textPartitionBytes);
 const sequence=textMemory.reservationObservation.sequence;
 assert.throws(()=>textMemory.reserve(1),/TEXT_MEMORY_BUDGET/);
 assert.throws(()=>reserve(ledger,1),/ALLOCATION_BUDGET/);
 assert.throws(()=>central.resize({cpuBytes:L.cpuBytes}),/ALLOCATION_BUDGET/);
 assert.equal(textMemory.reservationObservation.sequence,sequence);assertComplete(witness(ledger),L.cpuBytes,L.cpuBytes);
 text.release();const releasedSequence=textMemory.reservationObservation.sequence;text.release();
 assert.equal(textMemory.reservationObservation.sequence,releasedSequence);
 central.release();central.release();ledger.endCpuObservationWindow('failed-admission');
 assertComplete(witness(ledger),L.cpuBytes);assert.equal(ledger.snapshot().activeRecords,0);
});

test('the backend mirror participates in pool admission but never browser CPU observation',async()=>{
 const {ledger,textMemory,ALLOCATION_LIMITS:L}=await fixture();ledger.beginCpuObservationWindow('backend-mirror');
 const mirror=textMemory.reserve(L.cpuBytes-L.textPartitionBytes,'other');
 assert.equal(textMemory.snapshot.cpuBytes,L.cpuBytes-L.textPartitionBytes);assert.equal(textMemory.snapshot.textBytes,0);
 const central=reserve(ledger,100),text=textMemory.reserve(20);
 assertComplete(witness(ledger),120,120);assert.equal(ledger.snapshot().cpuBytes,120);
 text.release();central.release();mirror.release();ledger.endCpuObservationWindow('backend-mirror');assertComplete(witness(ledger),120);
});

test('acknowledgements survive lost responses and a competing active id cannot reset the window',async()=>{
 const {ledger,textMemory}=await fixture(),begin=ledger.beginCpuObservationWindow('retry-safe');
 const text=textMemory.reserve(80);text.release();
 assert.deepEqual(ledger.beginCpuObservationWindow('retry-safe'),begin);
 assert.throws(()=>ledger.beginCpuObservationWindow('competing-window'),/ALLOCATION_WINDOW_ACTIVE/);
 assert.throws(()=>ledger.endCpuObservationWindow('competing-window'),/ALLOCATION_WINDOW_ID/);
 const end=ledger.endCpuObservationWindow('retry-safe');
 assert.deepEqual(ledger.endCpuObservationWindow('retry-safe'),end);assert.deepEqual(ledger.beginCpuObservationWindow('retry-safe'),begin);
 for(const ack of [begin,end]){
  assert.equal(ack.kind,'combined-cpu-window-ack-1');assert.equal(ack.schemaVersion,1);assert.equal(ack.id,'retry-safe');
  assert.equal(typeof ack.ledgerInstanceId,'string');assert(ack.ledgerInstanceId.length>0);assert.equal(ack.ordinal,1);
  assert.equal(ack.clock,'browser-performance');assert(Number.isFinite(ack.clockOriginMs));assert(Number.isFinite(ack.atMs));
  assert(Number.isSafeInteger(ack.sequence));assert(Object.isFrozen(ack));
  assert(Object.values(ack).every(value=>value===null||['string','boolean','number'].includes(typeof value)));
 }
 assert.equal(begin.boundary,'begin');assert.equal(end.boundary,'end');assert.equal(begin.sealed,false);assert.equal(end.sealed,true);
 assert.equal(begin.ledgerInstanceId,end.ledgerInstanceId);assert(end.sequence>=begin.sequence);assert(end.atMs>=begin.atMs);
 const window=witness(ledger);assertComplete(window,80);assert.equal(window.startMs,begin.atMs);assert.equal(window.endMs,end.atMs);
 assert.equal(window.startSequence,begin.sequence);assert.equal(window.endSequence,end.sequence);
});

test('only a declared successor replaces the sealed immutable window and resets its scoped peak',async()=>{
 const {ledger,textMemory}=await fixture();ledger.beginCpuObservationWindow('first');
 const high=textMemory.reserve(500);high.release();ledger.endCpuObservationWindow('first');
 const first=witness(ledger),saved=structuredClone(first);assert(Object.isFrozen(first));assert(Object.isFrozen(first.failures));
 ledger.observeTextReservations(()=>textMemory.snapshot.textBytes);assert.deepEqual(witness(ledger),saved);
 ledger.observeTextReservations(()=>textMemory.snapshot.textBytes,textMemory);assert.deepEqual(witness(ledger),saved);
 const between=reserve(ledger,700);between.release();assert.deepEqual(witness(ledger),saved);
 const next=ledger.beginCpuObservationWindow('second');assert.equal(next.ordinal,first.ordinal+1);assert.equal(next.ledgerInstanceId,first.ledgerInstanceId);
 const low=textMemory.reserve(25);low.release();ledger.endCpuObservationWindow('second');
 assertComplete(witness(ledger),25);assert.deepEqual(first,saved);assert.equal(ledger.snapshot().combinedCpu.observedPeakBytes,700);
});

test('window ids are bounded and invalid ids never create an observation window',async()=>{
 const {ledger}=await fixture();
 for(const id of ['', 'a'.repeat(65),'contains space','https://private.invalid/prompt',null,42])assert.throws(()=>ledger.beginCpuObservationWindow(id),/ALLOCATION_WINDOW_ID/);
 assert.equal(ledger.snapshot().combinedCpu.window,null);
 ledger.beginCpuObservationWindow('valid_01-02');ledger.endCpuObservationWindow('valid_01-02');assertComplete(witness(ledger),0);
});

test('sampled-only text sources remain explicitly incomplete even when every observed value is zero',async()=>{
 const {ledger,textMemory}=await fixture({bind:false});ledger.observeTextReservations(()=>textMemory.snapshot.textBytes);
 ledger.beginCpuObservationWindow('sampled-only');const transient=textMemory.reserve(300);transient.release();ledger.endCpuObservationWindow('sampled-only');
 const window=witness(ledger);assert.equal(window.peakBytes,0);assert.equal(window.observationComplete,false);
 assert(window.failures.includes('text-observer-unavailable'));assert.equal(window.ownerCoverageComplete,false);
});

test('replacing a live observer invalidates the window without rewriting its witnessed lower bound',async()=>{
 const {ledger,textMemory}=await fixture();ledger.beginCpuObservationWindow('rebound');
 const text=textMemory.reserve(40);ledger.observeTextReservations(()=>textMemory.snapshot.textBytes);
 text.release();ledger.endCpuObservationWindow('rebound');const window=witness(ledger);
 assert.equal(window.peakBytes,40);assert.equal(window.currentBytes,0);assert.equal(window.observationComplete,false);
 assert(window.failures.includes('text-observer-rebound'));assert(window.failures.includes('text-observer-unavailable'));
});

test('a missed release invalidates completeness without combining stale text with a later central lease',async()=>{
 let drop=false;
 const {ledger,textMemory}=await fixture({source:pool=>({
  observeReservations(observer){return pool.observeReservations((...args)=>{if(!drop)observer(...args);});},
  get reservationObservation(){return pool.reservationObservation;},
 })});
 ledger.beginCpuObservationWindow('missed-release');const text=textMemory.reserve(80);
 drop=true;text.release();const central=reserve(ledger,40);central.release();drop=false;
 ledger.endCpuObservationWindow('missed-release');const window=witness(ledger);
 assert.equal(window.peakBytes,80);assert.equal(window.currentBytes,0);assert.equal(window.observationComplete,false);
 assert(window.failures.includes('text-sequence-discontinuity'));assert.notEqual(window.peakBytes,120);
});

test('a stale getter cannot create a peak from text already released by the actual pool',async()=>{
 const {ledger,textMemory}=await fixture();ledger.beginCpuObservationWindow('stale-getter');
 const text=textMemory.reserve(100);text.release();
 ledger.observeTextReservations(()=>100,textMemory);
 const central=reserve(ledger,200);central.release();
 ledger.observeTextReservations(()=>textMemory.snapshot.textBytes,textMemory);
 ledger.endCpuObservationWindow('stale-getter');const window=witness(ledger);
 assert.equal(window.peakBytes,100);assert.equal(window.currentBytes,0);assert.equal(window.observationComplete,false);
 assert(window.failures.includes('text-observation-invalid'));assert.notEqual(window.peakBytes,300);
 assert.equal(window.ledgerBytesAtPeak,0);assert.equal(window.textBytesAtPeak,100);
});

test('a disconnected source invalidates the active window and a later clean window can rebaseline',async()=>{
 let detach;
 const {ledger,textMemory}=await fixture({source:pool=>({
  observeReservations(observer){detach=pool.observeReservations(observer);return detach;},
  get reservationObservation(){return pool.reservationObservation;},
 })});
 ledger.beginCpuObservationWindow('disconnect');detach();
 const invisible=textMemory.reserve(64);invisible.release();ledger.endCpuObservationWindow('disconnect');
 const incomplete=witness(ledger);assert.equal(incomplete.observationComplete,false);assert(incomplete.failures.includes('text-observer-disconnected'));
 ledger.observeTextReservations(()=>textMemory.snapshot.textBytes,textMemory);
 ledger.beginCpuObservationWindow('clean-successor');const observed=textMemory.reserve(32);observed.release();ledger.endCpuObservationWindow('clean-successor');
 assertComplete(witness(ledger),32);assert.equal(incomplete.observationComplete,false);
});

test('failed callback delivery is visible even after the pool returns to the sampled byte count',async()=>{
 let failNotification=false;
 const {ledger,textMemory}=await fixture({source:pool=>({
  observeReservations(observer){return pool.observeReservations((...args)=>{if(failNotification)throw Error('injected-delivery-fault');observer(...args);});},
  get reservationObservation(){return pool.reservationObservation;},
 })});
 ledger.beginCpuObservationWindow('callback-fault');failNotification=true;
 const missed=textMemory.reserve(65);missed.release();failNotification=false;
 ledger.endCpuObservationWindow('callback-fault');const incomplete=witness(ledger);
 assert.equal(incomplete.peakBytes,0);assert.equal(incomplete.currentBytes,0);assert.equal(incomplete.observationComplete,false);
 assert(incomplete.failures.includes('text-observer-fault'));assert(textMemory.reservationObservation.observerFaults>0);
 ledger.beginCpuObservationWindow('callback-recovered');const visible=textMemory.reserve(70);visible.release();ledger.endCpuObservationWindow('callback-recovered');
 assertComplete(witness(ledger),70);assert.equal(incomplete.observationComplete,false);
});

test('repeated controller registration shares one actual pool listener without a notification gap',async()=>{
 const {ledger,textMemory}=await fixture();ledger.beginCpuObservationWindow('same-source');
 ledger.observeTextReservations(()=>textMemory.snapshot.textBytes,textMemory);
 ledger.observeTextReservations(()=>textMemory.snapshot.textBytes,textMemory);
 const text=textMemory.reserve(48);text.release();ledger.endCpuObservationWindow('same-source');assertComplete(witness(ledger),48);
 assert.throws(()=>textMemory.observeReservations(()=>{}),/TEXT_RESERVATION_OBSERVER_EXISTS/);
});

test('a failing text getter cannot lose an already booked central release handle',async()=>{
 let failRead=false;
 const {ledger}=await fixture({read:pool=>{if(failRead)throw Error('injected-read-fault');return pool.snapshot.textBytes;}});
 ledger.beginCpuObservationWindow('getter-fault');failRead=true;
 const central=reserve(ledger,96);central.release();failRead=false;
 ledger.endCpuObservationWindow('getter-fault');const snapshot=ledger.snapshot();
 assert.equal(snapshot.cpuBytes,0);assert.equal(snapshot.activeRecords,0);assert.equal(snapshot.combinedCpu.window.observationComplete,false);
 assert(snapshot.combinedCpu.window.failures.includes('text-observation-invalid'));
});

test('invalid clocks cannot fabricate an exact peak or lose a successful allocation handle',async()=>{
 let time=NaN;
 const {ledger}=await fixture({now:()=>time});
 assert.throws(()=>ledger.beginCpuObservationWindow('invalid-start'),/ALLOCATION_WINDOW_OBSERVATION/);
 assert.equal(ledger.snapshot().combinedCpu.window,null);
 time=100;ledger.beginCpuObservationWindow('clock-fault');time=NaN;
 const central=reserve(ledger,48);central.release();time=200;ledger.endCpuObservationWindow('clock-fault');
 const snapshot=ledger.snapshot();assert.equal(snapshot.cpuBytes,0);assert.equal(snapshot.activeRecords,0);
 assert.equal(snapshot.combinedCpu.window.observationComplete,false);assert(snapshot.combinedCpu.window.failures.includes('clock-invalid'));
 assert.equal(snapshot.combinedCpu.window.peakBytes,0,'unobserved intervals remain a lower bound');
});

test('clock regression after a nonpeak observation invalidates the scoped measurement',async()=>{
 let time=100;const {ledger}=await fixture({now:()=>time});ledger.beginCpuObservationWindow('clock-regression');
 time=200;const high=reserve(ledger,10);time=300;high.release();
 time=250;const low=reserve(ledger,1);time=350;low.release();ledger.endCpuObservationWindow('clock-regression');
 const window=witness(ledger);assert.equal(window.peakBytes,10);assert.equal(window.currentBytes,0);
 assert.equal(window.observationComplete,false);assert(window.failures.includes('clock-invalid'));
});

test('regressed boundary clocks never acknowledge a complete window and an end retry preserves failure',async()=>{
 let time=100;const {ledger}=await fixture({now:()=>time});
 time=90;assert.throws(()=>ledger.beginCpuObservationWindow('bad-begin'),/ALLOCATION_WINDOW_OBSERVATION/);
 time=150;assert.equal(ledger.snapshot().combinedCpu.window,null);ledger.beginCpuObservationWindow('retry-end');
 time=200;const central=reserve(ledger,10);time=300;central.release();
 time=250;assert.throws(()=>ledger.endCpuObservationWindow('retry-end'),/ALLOCATION_WINDOW_OBSERVATION/);
 time=400;const prefix=witness(ledger);assert.equal(prefix.sealed,false);assert.equal(prefix.observationComplete,false);
 const end=ledger.endCpuObservationWindow('retry-end'),window=witness(ledger);
 assert.equal(end.sealed,true);assert.equal(window.sealed,true);assert.equal(window.observationComplete,false);
 assert(window.failures.includes('clock-invalid'));assert.equal(window.peakBytes,10);assert(window.endMs>=window.peakAtMs);
});

test('ledger observer reentry is rejected before mutation and leaves the outer owner refundable',async()=>{
 let inject=false,ledgerRef,inner,innerError;
 const {ledger,textMemory}=await fixture({read:pool=>{
  if(inject){inject=false;try{inner=reserve(ledgerRef,30);}catch(error){innerError=error;}}
  return pool.snapshot.textBytes;
 }});ledgerRef=ledger;
 ledger.beginCpuObservationWindow('ledger-reentrant');inject=true;const outer=reserve(ledger,40);
 try{assert.equal(inner,undefined);assert.match(innerError?.message??'',/ALLOCATION_OBSERVER_REENTRANCY/);assert.equal(ledger.snapshot().cpuBytes,40);}
 finally{inner?.release();outer.release();}
 ledger.endCpuObservationWindow('ledger-reentrant');const window=witness(ledger);
 assert.equal(window.currentBytes,0);assert.equal(window.peakBytes,40);assert.equal(window.observationComplete,false);
 assert(window.failures.includes('observer-reentrant'));assert.equal(ledger.snapshot().activeRecords,0);
 ledger.beginCpuObservationWindow('reentrant-recovered');const text=textMemory.reserve(12);text.release();ledger.endCpuObservationWindow('reentrant-recovered');
 assertComplete(witness(ledger),12);
});

test('observer reentry cannot admit a second prompt owner or lose the first prompt handle',async()=>{
 let inject=false,ledgerRef,inner,innerError;
 const {ledger}=await fixture({read:pool=>{
  if(inject){inject=false;try{inner=ledgerRef.reserve({owner:'nested-prompt',kind:'prompt',cpuBytes:40*1024**2});}catch(error){innerError=error;}}
  return pool.snapshot.textBytes;
 }});ledgerRef=ledger;
 ledger.beginCpuObservationWindow('prompt-reentrant');inject=true;
 const outer=ledger.reserve({owner:'outer-prompt',kind:'prompt',cpuBytes:40*1024**2});
 try{assert.equal(inner,undefined);assert.match(innerError?.message??'',/ALLOCATION_OBSERVER_REENTRANCY/);assert.equal(ledger.snapshot().promptBytes,40*1024**2);}
 finally{inner?.release();outer.release();}
 ledger.endCpuObservationWindow('prompt-reentrant');const snapshot=ledger.snapshot();
 assert.equal(snapshot.promptBytes,0);assert.equal(snapshot.activeRecords,0);assert.equal(snapshot.combinedCpu.window.peakBytes,40*1024**2);
 assert.equal(snapshot.combinedCpu.window.observationComplete,false);assert(snapshot.combinedCpu.window.failures.includes('observer-reentrant'));
});

test('observer callbacks cannot resize or release an existing central owner before returning',async()=>{
 let injected;
 const {ledger,textMemory}=await fixture({read:pool=>{if(injected){const operation=injected;injected=undefined;operation();}return pool.snapshot.textBytes;}});
 const central=reserve(ledger,10);ledger.beginCpuObservationWindow('existing-owner-reentry');
 injected=()=>central.resize({cpuBytes:20});const first=textMemory.reserve(1);
 assert.equal(ledger.snapshot().cpuBytes,11);first.release();
 injected=()=>central.release();const second=textMemory.reserve(2);
 assert.equal(ledger.snapshot().cpuBytes,12);assert.equal(ledger.snapshot().activeRecords,1);second.release();central.release();
 ledger.endCpuObservationWindow('existing-owner-reentry');const snapshot=ledger.snapshot();
 assert.equal(snapshot.cpuBytes,0);assert.equal(snapshot.activeRecords,0);assert.equal(snapshot.combinedCpu.window.observationComplete,false);
 assert(snapshot.combinedCpu.window.failures.includes('observer-reentrant'));
});

test('pool listener exceptions never turn successful bookings into unreachable ownership',async()=>{
 const {textMemory}=await fixture({bind:false});let calls=0;
 const detach=textMemory.observeReservations(()=>{calls++;throw Error('injected-listener-fault');});
 const before=textMemory.reservationObservation.observerFaults,text=textMemory.reserve(72);
 assert.equal(textMemory.snapshot.textBytes,72);assert(textMemory.reservationObservation.observerFaults>before);
 text.release();assert.equal(textMemory.snapshot.textBytes,0);assert.equal(calls,3);detach();
 assert.equal(textMemory.reservationObservation.observing,false);
 const replacementDetach=textMemory.observeReservations(()=>{});const replacement=textMemory.reserve(11);replacement.release();replacementDetach();
 assert.equal(textMemory.snapshot.cpuBytes,0);
});

test('a reentrant pool listener is rejected before mutation and leaves the outer owner refundable',async()=>{
 const {textMemory}=await fixture({bind:false});let calls=0,attempted=false,nested,nestedError;
 const detach=textMemory.observeReservations(bytes=>{calls++;if(bytes>0&&!attempted){attempted=true;try{nested=textMemory.reserve(1);}catch(error){nestedError=error;}}});
 const outer=textMemory.reserve(5);
 assert(calls<=3,'recursive notifications must be bounded before the nested reserve returns');
 try{assert.equal(nested,undefined);assert.match(nestedError?.message??'',/TEXT_RESERVATION_OBSERVER_REENTRANCY/);
  assert(textMemory.reservationObservation.observerFaults>0);assert.equal(textMemory.snapshot.textBytes,5);}
 finally{detach();nested?.release();outer.release();}
 assert.equal(textMemory.snapshot.textBytes,0);
});

test('prepared-output retain callbacks cannot overwrite the release handle for the outer booking',async()=>{
 const {textMemory,retainPrepared,releasePrepared}=await fixture({bind:false,prepared:true}),target={};let inject=true;
 const detach=textMemory.observeReservations(bytes=>{if(bytes>0&&inject){inject=false;retainPrepared(target,1);}});
 retainPrepared(target,5);assert.equal(textMemory.snapshot.textBytes,5);assert(textMemory.reservationObservation.observerFaults>0);
 detach();releasePrepared(target);releasePrepared(target);assert.equal(textMemory.snapshot.textBytes,0);
});

test('prepared-output release callbacks cannot detach a still-live stored booking',async()=>{
 const {textMemory,retainPrepared,releasePrepared}=await fixture({bind:false,prepared:true}),target={};retainPrepared(target,5);let inject=false;
 const detach=textMemory.observeReservations(bytes=>{if(bytes>0&&inject){inject=false;releasePrepared(target);}});
 inject=true;const trigger=textMemory.reserve(1);
 assert.equal(textMemory.snapshot.textBytes,6);assert(textMemory.reservationObservation.observerFaults>0);
 detach();trigger.release();releasePrepared(target);assert.equal(textMemory.snapshot.textBytes,0);
});

test('a spent disposer cannot remove a replacement subscription with the same callback identity',async()=>{
 const {textMemory}=await fixture({bind:false});let calls=0;const listener=()=>{calls++;};
 const first=textMemory.observeReservations(listener);first();const second=textMemory.observeReservations(listener);first();
 assert.equal(textMemory.reservationObservation.observing,true);const text=textMemory.reserve(9);text.release();assert.equal(calls,4);
 second();assert.equal(textMemory.reservationObservation.observing,false);assert.equal(textMemory.snapshot.textBytes,0);
});

test('exact included-owner observation cannot certify unknown CPU backing or total allocation coverage',async()=>{
 const {ledger,allocationLedger,COMBINED_CPU_OBSERVER_BYTES}=await fixture();
 ledger.beginCpuObservationWindow('coverage');ledger.endCpuObservationWindow('coverage');
 const snapshot=ledger.snapshot();assertComplete(snapshot.combinedCpu.window,0);
 assert.equal(snapshot.complete,false);assert.equal(snapshot.coverage.cpu,false);assert.equal(snapshot.combinedCpu.ownerCoverageComplete,false);
 assert.equal(snapshot.combinedCpu.observationComplete,false,'a scoped exact window does not certify pre-window lifetime history');
 assert(snapshot.missing.includes('app-payload-ownership-incomplete'));assert(snapshot.combinedCpu.window.missing.includes('engine-and-dom-allocations'));
 const before=allocationLedger.snapshot();assert(before.byKind.control.cpuBytes>=COMBINED_CPU_OBSERVER_BYTES);
 allocationLedger.beginCpuObservationWindow('bounded-metadata');allocationLedger.endCpuObservationWindow('bounded-metadata');
 const after=allocationLedger.snapshot();assert.equal(after.activeRecords,before.activeRecords);assert.equal(after.byKind.control.cpuBytes,before.byKind.control.cpuBytes);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {isolatedDiagnosticModules} from '../owned-preview-module.mjs';
import {readStagedSource,stagedModuleURL} from '../adapter-upload-module.mjs';

// Every owner below is a production AllocationLedger/MemoryPool in an isolated
// actual diagnostic graph. Tests never supply calculated snapshots to the ledger.
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
let serial=0;
async function fixture({now,source,ledgerFirst=false}={}){
 const identity='text-resource-ledger-'+ ++serial,{allocationsURL,diagnosticMemoryURL}=await isolatedDiagnosticModules();
 const contractsURL=await stagedModuleURL('src/text/contracts.ts',{},identity);
 const budgetURL=await stagedModuleURL('src/protocol/text-budget.ts',{},identity);
 const admissionURL=await stagedModuleURL('src/text/admission.ts',{'./contracts':contractsURL},identity);
 const profile=JSON.parse(await readStagedSource('src/text/profile.json'));
 const memoryURL=await stagedModuleURL('src/text/memory.ts',{
  '../observability/diagnostic-memory.js':diagnosticMemoryURL,'./contracts':contractsURL,'./admission':admissionURL,
  '../protocol/text-budget':budgetURL,'./profile.json':data('const profile='+JSON.stringify(profile)+';export default profile;export const engine=profile.engine;'),
 },identity);
 const earlyAllocation=ledgerFirst?await import(allocationsURL):null;
 const memory=await import(memoryURL),allocation=earlyAllocation??await import(allocationsURL),diagnostics=await import(diagnosticMemoryURL),pool=new memory.MemoryPool();
 let clock=10;const ledger=new allocation.AllocationLedger(undefined,now??(()=>++clock));
 ledger.observeTextReservations(()=>pool.snapshot.textBytes,source?source(pool):pool);
 return {...allocation,...memory,...diagnostics,ledger,pool};
}
const reserve=(ledger,kind,cpuBytes,extra={})=>ledger.reserve({owner:'actual-text-resource-test',kind,cpuBytes,...extra});
const total=point=>point.cpu.reduce((sum,value)=>sum+value,point.poolTextBytes);
function seal(ledger,id){ledger.endTextResourceObservationWindow(id);return ledger.copyTextResourceObservation();}
function complete(window){
 assert.equal(window.sealed,true);assert.equal(window.observationComplete,true);assert.deepEqual(window.failures,[]);
 assert.equal(window.dropped,0);assert.equal(window.rows.length,window.transitionCount);
 let previous=window.initial;
 for(const row of window.rows){
  assert.equal(row.sequence,previous.sequence+1);assert(row.atMs>=previous.atMs);
  assert.equal(row.ledgerSequence-previous.ledgerSequence+row.textSequence-previous.textSequence,1);
  previous=row;
 }
 assert.deepEqual(window.final,{...previous,atMs:window.final.atMs});
}

test('actual transient text bookings survive release between snapshots and disjoint peaks are not added',async()=>{
 const {ledger,pool}=await fixture();ledger.beginTextResourceObservationWindow('transient');
 const font=reserve(ledger,'font',900);font.release();
 const text=pool.reserve(600);text.release();
 const window=seal(ledger,'transient');complete(window);
 assert.equal(total(window.initial),0);assert.equal(total(window.final),0);
 assert.deepEqual(window.peakCpu,{bytes:900,sequence:1});
 assert.deepEqual(window.rows.map(total),[900,0,600,0]);
 assert.notEqual(window.peakCpu.bytes,900+600);
 const snapshot=ledger.snapshot();assert.equal(snapshot.complete,false);assert.equal(snapshot.coverage.cpu,false);
});

test('one simultaneous point includes every conservative text kind and excludes display, blob and bitmap storage',async()=>{
 const {ledger,pool,TEXT_RESOURCE_CPU_KINDS}=await fixture();ledger.beginTextResourceObservationWindow('simultaneous');
 const amounts=[11,13,17,19,23,29,31];
 const leases=TEXT_RESOURCE_CPU_KINDS.map((kind,index)=>reserve(ledger,kind,amounts[index],{gpuBytes:kind==='font'?5:kind==='text'?7:0}));
 const text=pool.reserve(37);
 const excluded=['canvas','blob','bitmap'].map(kind=>reserve(ledger,kind,1000,{gpuBytes:10000}));
 const before=ledger.copyTextResourceObservation();assert.equal(before.peakCpu.bytes,180);assert.equal(before.peakGlyphGpu.bytes,12);
 assert.deepEqual(before.rows[7].cpu,amounts);assert.equal(before.rows[7].poolTextBytes,37);
 for(const lease of [...leases,...excluded,text])lease.release();
 const window=seal(ledger,'simultaneous');complete(window);
 assert.deepEqual(window.peakCpu,{bytes:180,sequence:8});assert.equal(window.peakGlyphGpu.bytes,12);
 assert.equal(window.transitionCount,22);assert.equal(total(window.final),0);assert.equal(window.final.glyphGpuBytes,0);
 assert.equal(window.cpuKinds.includes('canvas'),false);
});

test('actual split and replace preserve atomic ownership, exact sequences and idempotent release',async()=>{
 const {ledger,pool}=await fixture();ledger.beginTextResourceObservationWindow('transfer');
 const original=pool.reserve(100),split=pool.split(original,40),replacement=pool.replace(original,90);
 assert.equal(original.bytes,60);assert.equal(split.bytes,40);assert.equal(replacement.bytes,90);
 original.release();assert.equal(pool.snapshot.textBytes,130);
 split.release();split.release();replacement.release();replacement.release();
 const window=seal(ledger,'transfer');complete(window);
 assert.deepEqual(window.rows.map(row=>row.poolTextBytes),[100,100,130,90,0]);
 assert.deepEqual(window.rows.map(row=>row.textSequence-window.initial.textSequence),[1,2,3,4,5]);
 assert.deepEqual(window.peakCpu,{bytes:130,sequence:3});assert.equal(window.transitionCount,5);
});

test('the text partition stays within the unchanged CPU cap and backend mirror bookings are not counted twice',async()=>{
 const {ledger,pool,ALLOCATION_LIMITS:L}=await fixture();
 assert.equal(L.cpuBytes,512*1024**2);assert.equal(L.textPartitionBytes,128*1024**2);
 ledger.beginTextResourceObservationWindow('caps');
 const mirror=pool.reserve(384*1024**2,'other'),text=pool.reserve(L.textPartitionBytes);
 const central=reserve(ledger,'font',L.cpuBytes-L.textPartitionBytes);
 assert.throws(()=>pool.reserve(1),/TEXT_MEMORY_BUDGET/);
 assert.throws(()=>pool.replace(text,L.textPartitionBytes+1),/TEXT_MEMORY_BUDGET/);
 assert.throws(()=>reserve(ledger,'control',1),/ALLOCATION_BUDGET/);
 assert.equal(pool.snapshot.textBytes,L.textPartitionBytes);assert.equal(pool.snapshot.cpuBytes,L.cpuBytes);
 text.release();mirror.release();central.release();
 const window=seal(ledger,'caps');complete(window);
 assert.equal(window.peakCpu.bytes,L.cpuBytes);assert.equal(window.rows[0].poolTextBytes,0);
 assert.equal(window.transitionCount,6,'refusals do not mint resource transitions');
});

test('observed prompt ownership retains the actual overage without clipping to admission limits',async()=>{
 const {ledger,ALLOCATION_LIMITS:L}=await fixture();ledger.beginTextResourceObservationWindow('observed-prompt');
 const prompt=ledger.reserveObservedPrompt({owner:'actual-native-prompt',cpuBytes:32,handles:1});
 const actual=L.cpuBytes+123;prompt.observeCPUBytes(actual);
 assert.throws(()=>reserve(ledger,'scratch',1),/ALLOCATION_BUDGET/);
 prompt.reconcileCPUBytes(0);prompt.release();
 const window=seal(ledger,'observed-prompt');complete(window);
 assert.equal(window.peakCpu.bytes,actual);assert.equal(window.rows[1].cpu[3],actual);
 assert.equal(total(window.final),0);assert.equal(ledger.snapshot().complete,false);
});

test('eager actual singleton registration starts before the first default pool booking and preserves its startup epoch',async()=>{
 const {allocationLedger,textMemory,TEXT_RESOURCE_OBSERVER_BYTES}=await fixture();
 assert.equal(textMemory.reservationObservation.observing,true);
 const identity=allocationLedger.textResourceStartupIdentity();assert(identity);assert.equal(identity.ended,false);
 const initial=allocationLedger.copyTextResourceObservation();assert.equal(initial.id,'startup-'+identity.ledgerInstanceId);
 assert.equal(initial.initial.poolTextBytes,0);assert.equal(initial.initial.textSequence,0);assert.equal(initial.transitionCount,0);
 assert(initial.initial.cpu[2]>=TEXT_RESOURCE_OBSERVER_BYTES,'observer journal storage is booked in the actual control owner');
 const baseline=total(initial.initial),text=textMemory.reserve(71);text.release();
 const boundaries=allocationLedger.sealTextResourceStartupWindow(),window=allocationLedger.copyTextResourceObservation();complete(window);
 assert.deepEqual(boundaries.begin,identity.begin);assert.equal(boundaries.end.id,initial.id);
 assert.deepEqual(window.rows.map(row=>row.poolTextBytes),[71,0]);assert.equal(window.peakCpu.bytes,baseline+71);
 assert.deepEqual(allocationLedger.sealTextResourceStartupWindow(),boundaries);
 const next=allocationLedger.beginTextResourceObservationWindow('after-startup');
 assert.equal(next.ordinal,identity.begin.ordinal+1);assert.equal(next.ledgerInstanceId,identity.ledgerInstanceId);
 assert.throws(()=>allocationLedger.sealTextResourceStartupWindow(),/TEXT_RESOURCE_STARTUP_UNAVAILABLE/);
 complete(seal(allocationLedger,'after-startup'));
});

test('sealed witnesses and acknowledgments are immutable, retries are idempotent and successive windows do not reset owners',async()=>{
 const {ledger,pool}=await fixture(),retained=pool.reserve(25);
 const begin=ledger.beginTextResourceObservationWindow('first');assert.equal(ledger.beginTextResourceObservationWindow('first'),begin);
 assert.throws(()=>ledger.beginTextResourceObservationWindow('competing'),/TEXT_RESOURCE_WINDOW_ACTIVE/);
 const end=ledger.endTextResourceObservationWindow('first');assert.equal(ledger.endTextResourceObservationWindow('first'),end);
 const window=ledger.copyTextResourceObservation(),saved=structuredClone(window);complete(window);
 assert(Object.isFrozen(window));assert(Object.isFrozen(window.initial.cpu));assert(Object.isFrozen(window.rows));assert(Object.isFrozen(window.failures));
 const temporary=pool.reserve(7);temporary.release();assert.deepEqual(ledger.copyTextResourceObservation(),saved);
 const next=ledger.beginTextResourceObservationWindow('second');assert.equal(next.ordinal,begin.ordinal+1);
 assert.equal(ledger.copyTextResourceObservation().initial.poolTextBytes,25);
 retained.release();complete(seal(ledger,'second'));assert.deepEqual(window,saved);
});

test('bounded journal overflow preserves the observed peak but can never claim a complete inventory',async()=>{
 const {ledger,pool,TEXT_RESOURCE_ROW_LIMIT}=await fixture();ledger.beginTextResourceObservationWindow('overflow');
 for(let index=0;index<TEXT_RESOURCE_ROW_LIMIT/2+2;index++){const text=pool.reserve(index+1);text.release();}
 const window=seal(ledger,'overflow');
 assert.equal(window.rows.length,4096);assert.equal(window.transitionCount,4100);assert.equal(window.dropped,4);
 assert.equal(window.observationComplete,false);assert.deepEqual(window.failures,['row-limit']);
 assert.deepEqual(window.peakCpu,{bytes:2050,sequence:4099});assert.equal(total(window.final),0);
});

test('a clock failure taints the entire window even after the source clock recovers',async()=>{
 let at=100,bad=false;const {ledger,pool}=await fixture({now:()=>bad?NaN:++at});
 ledger.beginTextResourceObservationWindow('clock-fault');bad=true;const text=pool.reserve(42);
 assert.throws(()=>ledger.endTextResourceObservationWindow('clock-fault'),/TEXT_RESOURCE_POINT_UNAVAILABLE/);
 bad=false;text.release();const window=seal(ledger,'clock-fault');
 assert.equal(window.observationComplete,false);assert(window.failures.includes('clock-invalid'));assert(window.failures.includes('transition-gap'));
});

test('an actual source rebind cannot erase an earlier peak or restore complete observation',async()=>{
 const {ledger,pool,MemoryPool}=await fixture();ledger.beginTextResourceObservationWindow('rebound');
 const first=pool.reserve(80);first.release();
 const successor=new MemoryPool();ledger.observeTextReservations(()=>successor.snapshot.textBytes,successor);
 const second=successor.reserve(9);second.release();
 const window=seal(ledger,'rebound');assert.equal(window.observationComplete,false);
 assert(window.failures.includes('text-observer-rebound'));assert.equal(window.peakCpu.bytes,80);
 assert.equal(pool.reservationObservation.observing,false);assert.equal(successor.reservationObservation.observing,true);
});

test('a lost actual pool notification and disconnection remain incomplete after a new subscription',async()=>{
 let detach;const {ledger,pool}=await fixture({source:pool=>({
  observeReservations(observer){detach=pool.observeReservations(observer);return detach;},
  get reservationObservation(){return pool.reservationObservation;},
 })});ledger.beginTextResourceObservationWindow('disconnected');detach();const text=pool.reserve(55);
 assert.throws(()=>ledger.endTextResourceObservationWindow('disconnected'),/TEXT_RESOURCE_POINT_UNAVAILABLE/);
 ledger.observeTextReservations(()=>pool.snapshot.textBytes,pool);text.release();
 const window=seal(ledger,'disconnected');assert.equal(window.observationComplete,false);
 assert(window.failures.includes('text-observer-disconnected'));assert(window.failures.includes('text-sequence-discontinuity'));
 assert(window.failures.includes('text-observer-rebound'));
});

test('reentrant mutation through the actual source cannot publish complete or uncharged ownership',async()=>{
 let armed=false,nestedError;const {ledger,pool}=await fixture({source:pool=>({
  observeReservations(observer){return pool.observeReservations(observer);},
  get reservationObservation(){if(armed){armed=false;try{pool.reserve(1);}catch(error){nestedError=error;}}return pool.reservationObservation;},
 })});ledger.beginTextResourceObservationWindow('reentrant');armed=true;const text=pool.reserve(17);
 assert.match(nestedError?.message??'',/TEXT_RESERVATION_OBSERVER_REENTRANCY/);
 assert.equal(pool.snapshot.textBytes,17);assert(pool.reservationObservation.observerFaults>0);
 text.release();const window=seal(ledger,'reentrant');
 assert.equal(window.observationComplete,false);assert(window.failures.includes('text-observer-fault'));assert.equal(total(window.final),0);
});


test('the source bridge binds the actual pool in either import order and refuses replacement authorities',async()=>{
 for(const ledgerFirst of [false,true]){
  const {allocationLedger,textMemory,MemoryPool,publishTextReservationSource,observeTextReservationSource}=await fixture({ledgerFirst});
  const before=allocationLedger.copyTextResourceObservation();assert(before);assert.equal(before.initial.poolTextBytes,0);
  const sequence=textMemory.reservationObservation.sequence;
  publishTextReservationSource(textMemory);
  assert.equal(textMemory.reservationObservation.sequence,sequence,'repeat publication does not fabricate a reservation');
  assert.throws(()=>publishTextReservationSource(new MemoryPool()),/DIAGNOSTIC_TEXT_SOURCE_EXISTS/);
  assert.throws(()=>observeTextReservationSource(()=>{}),/DIAGNOSTIC_TEXT_CONSUMER_EXISTS/);
  const text=textMemory.reserve(91);text.release();allocationLedger.sealTextResourceStartupWindow();
  const window=allocationLedger.copyTextResourceObservation();complete(window);
  assert.deepEqual(window.rows.map(row=>row.poolTextBytes),[91,0]);
  assert.equal(window.initial.textSequence,0);assert.equal(window.final.textSequence,2);
 }
});

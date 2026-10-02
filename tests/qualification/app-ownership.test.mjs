import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {transformWithOxc} from 'vite';
import {isolatedDiagnosticModules} from '../owned-preview-module.mjs';

// Exercise the actual text reservation source and an isolated actual ledger.
// No snapshots, producer events or accounting totals are supplied by a double.
// OBSERVABILITY_STAGED_ROOT selects a complete diagnostic overlay through the
// shared loader. COMBINED_CPU_STAGED_ROOT can select the existing text bridge.
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
let fixtureSerial=0;
async function moduleURL(path,replacements={},identity=''){
 const source=process.env.COMBINED_CPU_STAGED_ROOT&&path==='src/text/memory.ts'?resolve(process.env.COMBINED_CPU_STAGED_ROOT,path):path;
 let code=(await transformWithOxc(await readFile(source,'utf8'),path)).code;
 for(const [name,url]of Object.entries(replacements))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));
 return data(code+'\n// '+identity);
}
async function fixture({now,source}={}){
 const identity='app-ownership-fixture-'+ ++fixtureSerial;
 const {allocationsURL,diagnosticMemoryURL}=await isolatedDiagnosticModules();
 const budgetURL=await moduleURL('src/protocol/text-budget.ts',{},identity),contractsURL=await moduleURL('src/text/contracts.ts',{},identity);
 const admissionURL=await moduleURL('src/text/admission.ts',{'./contracts':contractsURL},identity);
 const profile=JSON.parse(await readFile('src/text/profile.json','utf8'));
 const memoryURL=await moduleURL('src/text/memory.ts',{'./admission':admissionURL,'./contracts':contractsURL,'./profile.json':data('const profile='+JSON.stringify(profile)+';export default profile;export const engine=profile.engine;'),'../protocol/text-budget':budgetURL,'../observability/diagnostic-memory.js':diagnosticMemoryURL},identity);
 const {MemoryPool}=await import(memoryURL),textMemory=new MemoryPool(),allocationModule=await import(allocationsURL);
 let time=10;const ledger=new allocationModule.AllocationLedger(undefined,now??(()=>++time));
 ledger.observeTextReservations(()=>textMemory.snapshot.textBytes,source?source(textMemory):textMemory);
 return {ledger,textMemory,...allocationModule};
}

const reserve=(ledger,kind,cpuBytes,extra={})=>ledger.reserve({owner:'app-ownership-test',kind,cpuBytes,...extra});
const observedPrompt=(ledger,cpuBytes=32)=>ledger.reserveObservedPrompt({owner:'observed-editor',cpuBytes,handles:1});
const kinds=['copy','staging','scratch','blob','font','text','canvas','bitmap','prompt','control'];
const keys=['cpuBytes','gpuBytes','previewCacheBytes','handles'];
const row=(window,kind)=>{const result=window.kinds.find(value=>value.kind===kind);assert(result);return result;};
function assertReconciled(window){
 assert.equal(window.reconciled,true);assert.equal(window.observationComplete,true);assert.equal(window.globalCoverageComplete,false);assert.deepEqual(window.failures,[]);
 assert.deepEqual(window.kinds.map(value=>value.kind),kinds);
 let transitions=0;
 for(const value of window.kinds){
  assert.equal(value.initial.records+value.transitions.reserved-value.transitions.released,value.current.records);
  for(const key of keys)assert.equal(value.initial[key]+value.added[key]-value.removed[key],value.current[key]);
  transitions+=Object.values(value.transitions).reduce((sum,count)=>sum+count,0);
 }
 assert.equal(window.lastTransitionSequence-window.ledgerStartSequence,transitions);
 if(window.sealed)assert.equal(window.ledgerEndSequence,window.lastTransitionSequence);
}

test('every allocation kind reconciles real reserves, bidirectional resizes and releases within the CPU window',async()=>{
 const {ledger}=await fixture();
 const initial=kinds.map(kind=>reserve(ledger,kind,10,{gpuBytes:4,previewCacheBytes:2,handles:1}));
 const before=ledger.snapshot().appOwnership;assert.equal(before.window,null);assert.equal(before.point.observationComplete,true);
 assert.equal(before.point.centralCpuBytes,100);assert.equal(before.point.textBytes,0);assert.equal(before.point.totals.cpuBytes,100);
 assert.equal(before.point.kinds.reduce((sum,value)=>sum+value.records,0),10);
 const begin=ledger.beginCpuObservationWindow('all-kinds');
 for(const kind of kinds){
  const lease=reserve(ledger,kind,20,{gpuBytes:6,previewCacheBytes:3,handles:2});
  lease.resize({cpuBytes:30,gpuBytes:10,previewCacheBytes:4,handles:3});
  lease.resize({cpuBytes:5,gpuBytes:2,previewCacheBytes:1,handles:1});lease.release();
 }
 const end=ledger.endCpuObservationWindow('all-kinds'),snapshot=ledger.snapshot(),window=snapshot.appOwnership.window,cpu=snapshot.combinedCpu.window;
 assertReconciled(window);assert.equal(window.ledgerStartSequence,10);assert.equal(window.ledgerEndSequence,50);assert.equal(window.budgetRefusals,0);
 for(const value of window.kinds){
  const expected={records:1,cpuBytes:10,gpuBytes:4,previewCacheBytes:2,handles:1};
  assert.deepEqual(value.initial,expected);assert.deepEqual(value.current,expected);
  assert.deepEqual(value.transitions,{reserved:1,resized:2,released:1,observed:0});
  assert.deepEqual(value.added,{cpuBytes:30,gpuBytes:10,previewCacheBytes:4,handles:3});assert.deepEqual(value.removed,value.added);
 }
 assert.equal(window.ledgerInstanceId,cpu.ledgerInstanceId);assert.equal(window.id,cpu.id);assert.equal(window.ordinal,cpu.ordinal);
 assert.equal(window.startMs,begin.atMs);assert.equal(window.endMs,end.atMs);assert.equal(window.clockOriginMs,cpu.clockOriginMs);
 assert.equal(window.cpuStartSequence,begin.sequence);assert.equal(window.cpuEndSequence,end.sequence);
 assert.equal(window.cpuStartSequence,cpu.startSequence);assert.equal(window.cpuEndSequence,cpu.endSequence);
 assert.deepEqual(window.peaks,{gpuBytes:50,previewCacheBytes:24,handles:13});assert.equal(cpu.peakBytes,130);
 assert.equal(snapshot.complete,false);assert.equal(snapshot.coverage.cpu,false);assert.equal(snapshot.appOwnership.point.globalCoverageComplete,false);
 assert.equal(JSON.stringify(window).includes('app-ownership-test'),false,'the witness retains fixed kinds and counters rather than owner labels');
 for(const lease of initial)lease.release();assert.equal(ledger.snapshot().cpuBytes,0);
});

test('the ownership point binds current text authority without adding separate historical peaks',async()=>{
 const {ledger,textMemory}=await fixture();ledger.beginCpuObservationWindow('text-binding');
 const central=reserve(ledger,'scratch',200);central.release();
 const transient=textMemory.reserve(100);assert.equal(ledger.snapshot().text.observedPeakBytes,100);transient.release();
 const retained=textMemory.reserve(30),source=textMemory.reservationObservation;
 ledger.endCpuObservationWindow('text-binding');const snapshot=ledger.snapshot(),point=snapshot.appOwnership.point,window=snapshot.appOwnership.window;
 assertReconciled(window);assert.equal(point.observationComplete,true);assert.equal(point.centralCpuBytes,0);assert.equal(point.textBytes,30);assert.equal(point.totals.cpuBytes,30);
 assert.equal(point.textSequence,source.sequence);assert.equal(point.cpuSequence,snapshot.combinedCpu.sequence);
 assert.equal(point.kinds.find(value=>value.kind==='text').cpuBytes,0,'pool text is separate from central text-kind leases');
 assert.equal(window.text.initialBytes,0);assert.equal(window.text.currentBytes,30);assert.equal(window.text.endSequence,source.sequence);assert.equal(window.text.observationComplete,true);
 assert.equal(snapshot.combinedCpu.window.peakBytes,200);assert.notEqual(snapshot.combinedCpu.window.peakBytes,snapshot.peaks.cpuBytes+snapshot.text.observedPeakBytes);
 retained.release();assert.equal(ledger.snapshot().appOwnership.point.textBytes,0);assert.equal(window.text.currentBytes,30);
});

test('sealed ownership witnesses are immutable and successors reset only the scoped counters',async()=>{
 const {ledger}=await fixture();ledger.beginCpuObservationWindow('first-ownership');const first=reserve(ledger,'blob',7);first.release();ledger.endCpuObservationWindow('first-ownership');
 const sealed=ledger.snapshot().appOwnership.window,saved=structuredClone(sealed);assertReconciled(sealed);
 assert(Object.isFrozen(sealed));assert(Object.isFrozen(sealed.kinds));assert(Object.isFrozen(row(sealed,'blob').transitions));assert(Object.isFrozen(sealed.text));
 const between=reserve(ledger,'scratch',20);assert.deepEqual(ledger.snapshot().appOwnership.window,saved);
 const begin=ledger.beginCpuObservationWindow('second-ownership');ledger.endCpuObservationWindow('second-ownership');const next=ledger.snapshot().appOwnership.window;
 assertReconciled(next);assert.equal(next.ordinal,sealed.ordinal+1);assert.equal(next.ordinal,begin.ordinal);assert.equal(next.ledgerInstanceId,sealed.ledgerInstanceId);
 assert.equal(row(next,'scratch').initial.cpuBytes,20);assert.equal(row(next,'scratch').current.cpuBytes,20);
 for(const value of next.kinds)assert.deepEqual(value.transitions,{reserved:0,resized:0,released:0,observed:0});
 assert.equal(next.ledgerStartSequence,next.ledgerEndSequence);assert.deepEqual(sealed,saved);between.release();
});

test('unbound sampled text remains unknown even when central ownership equations reconcile',async()=>{
 const {ledger,textMemory}=await fixture();ledger.observeTextReservations(()=>textMemory.snapshot.textBytes);
 ledger.beginCpuObservationWindow('unbound-text');const central=reserve(ledger,'scratch',40);ledger.endCpuObservationWindow('unbound-text');
 const snapshot=ledger.snapshot(),point=snapshot.appOwnership.point,window=snapshot.appOwnership.window;
 assert.equal(point.centralCpuBytes,40);assert.equal(point.textBytes,null);assert.equal(point.textSequence,null);assert.equal(point.totals.cpuBytes,null);assert.equal(point.observationComplete,false);
 assert.equal(window.reconciled,true);assert.equal(window.observationComplete,false);assert.equal(window.text.initialBytes,null);assert.equal(window.text.currentBytes,null);
 assert(window.failures.includes('observer-incomplete'));assert(window.failures.includes('cpu-window-binding'));
 assert.equal(window.globalCoverageComplete,false);assert.equal(snapshot.complete,false);central.release();
});

test('failed clocks cannot reuse a good CPU point for later same-CPU or handles-only ownership changes',async()=>{
 for(const failure of ['nan','throw']){
  let bad=false,time=100;
  const {ledger}=await fixture({now:()=>{if(bad){if(failure==='throw')throw Error('injected-clock-fault');return NaN;}return ++time;}});
  const original=reserve(ledger,'scratch',40,{handles:1});ledger.beginCpuObservationWindow('failed-clock-'+failure);
  const good=ledger.snapshot().appOwnership.point;assert.equal(good.observationComplete,true);assert(Number.isFinite(good.atMs));
  bad=true;const handleOnly=reserve(ledger,'control',0,{handles:1});original.resize({handles:2});
  const failed=ledger.snapshot(),point=failed.appOwnership.point;
  assert.equal(point.centralCpuBytes,40);assert.equal(point.totals.handles,3);assert.equal(failed.activeRecords,2);
  assert.equal(point.kinds.reduce((sum,value)=>sum+value.handles,0),3);assert.equal(point.kinds.reduce((sum,value)=>sum+value.cpuBytes,0),40);
  assert(point.transitionSequence>good.transitionSequence);assert.equal(point.cpuSequence,good.cpuSequence,'a failed clock does not mint a new validated CPU sample');
  assert.equal(point.observationComplete,false);assert.equal(point.atMs,null);assert.equal(point.textBytes,null);assert.equal(point.totals.cpuBytes,null);
  bad=false;const recovered=ledger.snapshot();assert.equal(recovered.appOwnership.point.observationComplete,true);
  assert(recovered.appOwnership.point.cpuSequence>good.cpuSequence);assert(recovered.appOwnership.point.atMs>good.atMs);
  assert.equal(recovered.appOwnership.point.totals.cpuBytes,40);assert.equal(recovered.appOwnership.window.observationComplete,false);
  assert(recovered.combinedCpu.window.failures.includes('clock-invalid'));
  handleOnly.release();original.release();ledger.endCpuObservationWindow('failed-clock-'+failure);
  assert.equal(ledger.snapshot().appOwnership.window.observationComplete,false);assert.equal(ledger.snapshot().activeRecords,0);
 }
});

test('actual text source getters run under the mutation guard and cannot publish stale complete kind totals',async()=>{
 let armed=false,reads=0,ledgerRef,nested,nestedError;
 const {ledger}=await fixture({source:pool=>({
  observeReservations(observer){return pool.observeReservations(observer);},
  get reservationObservation(){
   reads++;if(armed){armed=false;try{nested=reserve(ledgerRef,'blob',7);nested.release();}catch(error){nestedError=error;}}
   return pool.reservationObservation;
  },
 })});ledgerRef=ledger;
 const original=reserve(ledger,'scratch',40,{handles:1});ledger.beginCpuObservationWindow('source-getter-reentry');
 const beforeReads=reads;armed=true;const snapshot=ledger.snapshot(),point=snapshot.appOwnership.point;
 assert.equal(reads,beforeReads+1,'the guarded combined observation is the only source getter read during snapshot');
 assert.equal(nested,undefined);assert.match(nestedError?.message??'',/ALLOCATION_OBSERVER_REENTRANCY/);
 assert.equal(snapshot.activeRecords,1);assert.equal(snapshot.cpuBytes,40);assert.equal(point.centralCpuBytes,40);
 assert.equal(point.kinds.reduce((sum,value)=>sum+value.records,0),1);assert.equal(point.kinds.reduce((sum,value)=>sum+value.cpuBytes,0),40);
 assert.equal(point.kinds.find(value=>value.kind==='blob').records,0);assert.equal(point.observationComplete,false);assert.equal(point.atMs,null);assert.equal(point.totals.cpuBytes,null);
 assert.equal(snapshot.appOwnership.window.observationComplete,false);assert(snapshot.combinedCpu.window.failures.includes('observer-reentrant'));
 const recovered=ledger.snapshot();assert.equal(recovered.appOwnership.point.observationComplete,true);assert.equal(recovered.appOwnership.window.observationComplete,false);
 original.release();ledger.endCpuObservationWindow('source-getter-reentry');assert.equal(ledger.snapshot().activeRecords,0);
});

test('observed prompt accounting uses one admitted slot and the larger admitted or observed byte count',async()=>{
 const {ledger}=await fixture(),lease=observedPrompt(ledger,100);
 assert.equal(ledger.snapshot().activeRecords,1);assert.equal(ledger.snapshot().handles,1);assert.equal(ledger.snapshot().promptBytes,100);
 lease.observeCPUBytes(60);assert.equal(ledger.snapshot().cpuBytes,100);
 lease.observeCPUBytes(200);const snapshot=ledger.snapshot();
 assert.equal(snapshot.cpuBytes,200);assert.equal(snapshot.promptBytes,200);assert.equal(snapshot.byKind.prompt.cpuBytes,200);
 assert.equal(snapshot.activeRecords,1);assert.equal(snapshot.handles,1);assert.notEqual(snapshot.cpuBytes,100+200);
 lease.release();assert.equal(ledger.snapshot().cpuBytes,0);assert.equal(ledger.snapshot().activeRecords,0);assert.equal(ledger.snapshot().handles,0);
});

test('ordinary resize and smaller observations cannot erase a retained native prompt floor',async()=>{
 const {ledger}=await fixture(),lease=observedPrompt(ledger,100);lease.observeCPUBytes(200);
 lease.observeCPUBytes(50);lease.resize({cpuBytes:40});
 assert.equal(ledger.snapshot().cpuBytes,200);assert.equal(ledger.snapshot().promptBytes,200);
 lease.resize({cpuBytes:300});assert.equal(ledger.snapshot().cpuBytes,300);
 lease.resize({cpuBytes:0});lease.observeCPUBytes(0);
 assert.equal(ledger.snapshot().cpuBytes,200,'without caller-confirmed retirement the observed owner remains charged');
 lease.release();assert.equal(ledger.snapshot().cpuBytes,0);
});

test('explicit reconciliation retires only the observed floor and preserves the admitted baseline',async()=>{
 const {ledger}=await fixture(),lease=observedPrompt(ledger,100);lease.observeCPUBytes(200);
 lease.reconcileCPUBytes(80);assert.equal(ledger.snapshot().cpuBytes,100);
 lease.resize({cpuBytes:40});assert.equal(ledger.snapshot().cpuBytes,80);
 lease.observeCPUBytes(90);assert.equal(ledger.snapshot().cpuBytes,90);
 lease.reconcileCPUBytes(0);assert.equal(ledger.snapshot().cpuBytes,40);
 lease.release();lease.release();assert.equal(ledger.snapshot().cpuBytes,0);assert.equal(ledger.snapshot().activeRecords,0);
});

test('observed floor changes have exact transition counts even when the admitted baseline absorbs their bytes',async()=>{
 const {ledger}=await fixture(),lease=observedPrompt(ledger,100);ledger.beginCpuObservationWindow('observed-transitions');
 lease.observeCPUBytes(60);lease.observeCPUBytes(40);lease.observeCPUBytes(60);
 lease.resize({cpuBytes:80});lease.reconcileCPUBytes(50);lease.observeCPUBytes(90);lease.reconcileCPUBytes(0);lease.release();
 ledger.endCpuObservationWindow('observed-transitions');const window=ledger.snapshot().appOwnership.window,prompt=row(window,'prompt');assertReconciled(window);
 assert.deepEqual(prompt.transitions,{reserved:0,resized:1,released:1,observed:4});
 assert.equal(prompt.initial.cpuBytes,100);assert.equal(prompt.current.cpuBytes,0);assert.equal(prompt.initial.records,1);assert.equal(prompt.current.records,0);
 assert.equal(prompt.added.cpuBytes,10);assert.equal(prompt.removed.cpuBytes,110);assert.equal(window.ledgerEndSequence-window.ledgerStartSequence,6);
});

test('observed prompt debt keeps the uncapped actual peak and blocks further ordinary prompt admission',async()=>{
 const {ledger,ALLOCATION_LIMITS:L}=await fixture(),lease=observedPrompt(ledger);
 ledger.beginCpuObservationWindow('prompt-debt');const actual=L.promptBytes+4096;lease.observeCPUBytes(actual);
 assert.equal(ledger.snapshot().promptBytes,actual);assert.equal(ledger.snapshot().cpuBytes,actual);
 assert.throws(()=>reserve(ledger,'prompt',1),/PROMPT_MEMORY_BUDGET/);
 lease.reconcileCPUBytes(0);lease.release();ledger.endCpuObservationWindow('prompt-debt');const snapshot=ledger.snapshot();
 assert.equal(snapshot.combinedCpu.window.peakBytes,actual);assert.equal(snapshot.promptPeakBytes,actual);assert.equal(snapshot.cpuBytes,0);
 assert.equal(snapshot.complete,false);assert.equal(snapshot.coverage.cpu,false);
 assertReconciled(snapshot.appOwnership.window);assert.equal(snapshot.appOwnership.window.budgetRefusals,1);
 assert.deepEqual(row(snapshot.appOwnership.window,'prompt').transitions,{reserved:0,resized:0,released:1,observed:2});
});

test('an actual observed CPU overage is retained and stops regular admission until ownership is reconciled',async()=>{
 const {ledger,ALLOCATION_LIMITS:L}=await fixture(),lease=observedPrompt(ledger);
 ledger.beginCpuObservationWindow('actual-cpu-overage');const actual=L.cpuBytes+123;lease.observeCPUBytes(actual);
 const overage=ledger.snapshot();assert.equal(overage.cpuBytes,actual);assert.equal(overage.combinedCpu.window.peakBytes,actual);
 assert.throws(()=>reserve(ledger,'scratch',1),/ALLOCATION_BUDGET/);assert.equal(ledger.snapshot().activeRecords,1);
 assert.throws(()=>lease.resize({cpuBytes:0}),/ALLOCATION_BUDGET/);assert.equal(ledger.snapshot().cpuBytes,actual);
 lease.reconcileCPUBytes(0);const admitted=reserve(ledger,'scratch',1);admitted.release();lease.release();
 ledger.endCpuObservationWindow('actual-cpu-overage');const snapshot=ledger.snapshot();assert.equal(snapshot.cpuBytes,0);assert.equal(snapshot.combinedCpu.window.peakBytes,actual);
 assertReconciled(snapshot.appOwnership.window);assert.equal(snapshot.appOwnership.window.budgetRefusals,2);
});

test('invalid observed values and methods on a released prompt never mutate live accounting',async()=>{
 const {ledger}=await fixture(),lease=observedPrompt(ledger,40);lease.observeCPUBytes(80);
 for(const bytes of [-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]){
  assert.throws(()=>lease.observeCPUBytes(bytes));assert.throws(()=>lease.reconcileCPUBytes(bytes));
  assert.equal(ledger.snapshot().cpuBytes,80);assert.equal(ledger.snapshot().activeRecords,1);
 }
 lease.release();assert.throws(()=>lease.observeCPUBytes(1),/ALLOCATION_RELEASED/);assert.throws(()=>lease.reconcileCPUBytes(0),/ALLOCATION_RELEASED/);
 assert.equal(ledger.snapshot().cpuBytes,0);assert.equal(ledger.snapshot().activeRecords,0);
});

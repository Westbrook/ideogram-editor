import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isolatedDiagnosticModules} from '../owned-preview-module.mjs';
import {readStagedSource,stagedModuleURL} from '../adapter-upload-module.mjs';
import {createTextResourceObserver,replayTextResourceEvidence,replayTextResourceWindow,verifyTextResourceArtifact,textResourceMeasurement,TEXT_RESOURCE_OPERATIONS} from '../../tooling/qualification/campaigns/browser-text-resources.mjs';

const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const rule={budgetId:'R35',name:'R35FontShapingCpuBytes',unit:'bytes'};
const sample={cache:'cold',ordinal:1,prime:false};
const cell={id:'actual-text-resource-cell',operation:'text.font-set'};
let serial=0;
async function fixture(t,{failed=false,overflow=false,glyphGpuBytes=0,controlBytes=0,finalBytes=0,finalGlyphGpuBytes=0}={}){
 const identity='text-resource-campaign-'+ ++serial,{allocationsURL,diagnosticMemoryURL}=await isolatedDiagnosticModules();
 const contractsURL=await stagedModuleURL('src/text/contracts.ts',{},identity);
 const budgetURL=await stagedModuleURL('src/protocol/text-budget.ts',{},identity);
 const admissionURL=await stagedModuleURL('src/text/admission.ts',{'./contracts':contractsURL},identity);
 const profile=JSON.parse(await readStagedSource('src/text/profile.json'));
 const memoryURL=await stagedModuleURL('src/text/memory.ts',{
  '../observability/diagnostic-memory.js':diagnosticMemoryURL,'./contracts':contractsURL,'./admission':admissionURL,
  '../protocol/text-budget':budgetURL,'./profile.json':data('const profile='+JSON.stringify(profile)+';export default profile;export const engine=profile.engine;'),
 },identity);
 const {MemoryPool}=await import(memoryURL),{AllocationLedger}=await import(allocationsURL);
 const pool=new MemoryPool();let clock=10;const ledger=new AllocationLedger(undefined,()=>++clock);
 ledger.observeTextReservations(()=>pool.snapshot.textBytes,pool);
 const output=await mkdtemp(join(tmpdir(),'ideogram-text-resource-'));t.after(()=>rm(output,{recursive:true,force:true}));
 let snapshots=0,releases=0,disposals=0;
 const api={
  beginTextResourceObservationWindow:id=>ledger.beginTextResourceObservationWindow(id),
  endTextResourceObservationWindow:id=>ledger.endTextResourceObservationWindow(id),
  readTextResourceSnapshot(){snapshots++;let live=true;return {value:ledger.copyTextResourceObservation(),release(){if(live){live=false;releases++;}}};},
 };
 // The transport alone is adapted: producer callbacks invoke the real ledger;
 // no synthetic rows, peaks, source events or complete flags feed the observer.
 const page={
  async evaluate(fn,arg){const previous=globalThis.__IDEOGRAM_PHASES__;globalThis.__IDEOGRAM_PHASES__=api;try{return fn(arg);}finally{if(previous===undefined)delete globalThis.__IDEOGRAM_PHASES__;else globalThis.__IDEOGRAM_PHASES__=previous;}},
  async evaluateHandle(fn,arg){const owner=await this.evaluate(fn,arg);return {async evaluate(project){return project(owner);},async dispose(){disposals++;}};},
 };
 const journalEvents=[];
 const observer=createTextResourceObserver({page,cell,sample,serial:1,fixtureIdentity:hash(Buffer.from('actual-fixture')),
  processIdentity:{pid:123,startIdentity:'isolated-test'},executableIdentity:{kind:'unreviewed-test-executable'},output,
  journal:async event=>journalEvents.push(structuredClone(event)),
 });
 const begin=await observer.begin();assert.deepEqual(await observer.begin(),begin);
 const transient=ledger.reserve({owner:'actual-font',kind:'font',cpuBytes:420,gpuBytes:glyphGpuBytes});transient.release();
 const text=pool.reserve(77),overlap=ledger.reserve({owner:'actual-staging',kind:'staging',cpuBytes:650});
 overlap.release();text.release();
 if(controlBytes){const control=ledger.reserve({owner:'actual-shared-control',kind:'control',cpuBytes:controlBytes});control.release();}
 if(overflow)for(let index=0;index<2050;index++){const lease=pool.reserve(index+1);lease.release();}
 const finalOwner=finalBytes||finalGlyphGpuBytes?ledger.reserve({owner:'actual-retained-final',kind:'font',cpuBytes:finalBytes,gpuBytes:finalGlyphGpuBytes}):null;
 const result=await observer.finish({failed});assert.equal(await observer.finish({failed}),result);finalOwner?.release();
 assert.equal(snapshots,1);assert.equal(releases,1);assert.equal(disposals,1);
 const retained=await readFile(result.artifact.path);
 const readRetained=async(path,{maximum})=>{assert.equal(path,result.artifact.path);assert.equal(maximum,8*1048576);return retained;};
 return {result,retained,journalEvents,readRetained,ledger,pool};
}
const replay=result=>replayTextResourceEvidence(result.evidence,{binding:result.evidence.binding,rendererOwnershipProof:null});
const verify=({result,readRetained,journalEvents},overrides={})=>verifyTextResourceArtifact({artifact:result.artifact,binding:result.evidence.binding,rendererOwnershipProof:null,readRetained,journalEvents,...overrides});

// These are resource-contract regressions, not native renderer authorization.
// With the reviewed renderer registry empty, every issued value stays incomplete.
test('actual transition evidence replays its simultaneous peak, retains exact bytes and remains unqualified without native ownership proof',async t=>{
 const fixtureValue=await fixture(t),{result,retained,journalEvents}=fixtureValue;
 assert.deepEqual(TEXT_RESOURCE_OPERATIONS,['text.font-set','text.mixed-ready','text.active-layout','text.apply','text.recovery','portable.reopen']);
 assert.equal(result.evidence.window.observationComplete,true);assert.equal(result.evidence.window.transitionCount,6);
 assert.deepEqual(result.evidence.window.rows.map(row=>row.cpu.reduce((sum,n)=>sum+n,row.poolTextBytes)),[420,0,77,727,77,0]);
 assert.deepEqual(result.evidence.window.peakCpu,{bytes:727,sequence:4});
 assert.equal(result.artifact.bytes,retained.length);assert.equal(result.artifact.sha256,hash(retained));
 assert.deepEqual(JSON.parse(retained.toString('utf8')),result.evidence);
 assert.deepEqual(journalEvents.map(row=>row.event),['text-resources-intent','text-resources-begin','text-resources-observed']);
 const replayed=replay(result),verified=await verify(fixtureValue);
 assert.equal(replayed.complete,false);assert.equal(verified.complete,false);
 assert.equal(replayed.measurements[0].value,727);assert.equal(replayed.measurements[1].value,0);
 assert(replayed.measurements.every(row=>row.complete===false));
 assert.deepEqual(replayed.missing,['exact-text-resource-source-native-runtime-review-unavailable']);
 assert(verified.proof);assert(Object.isFrozen(verified.proof));assert.notEqual(verified.proof,result.proof);
 assert.match(textResourceMeasurement({cell,sample,rule,proof:verified.proof}).reason,/exact-text-resource-source-native-runtime-review-unavailable/);
});

test('partial and failed action evidence preserves useful values but cannot produce an R35 measurement',async t=>{
 const {result}=await fixture(t,{failed:true}),value=replay(result);
 assert.equal(value.measurements[0].value,727);assert.equal(value.complete,false);assert(value.missing.includes('text-resource-action-failed'));
 assert.match(textResourceMeasurement({cell,sample,rule,proof:result.proof}).reason,/text-resource-action-failed/);
 const partial=structuredClone(result.evidence);partial.window.observationComplete=false;partial.window.failures=['text-observer-fault'];
 const replayed=replayTextResourceEvidence(partial);assert.equal(replayed.complete,false);assert(replayed.missing.includes('text-resource-transition-window-incomplete'));
 assert(replayed.measurements.every(row=>row.complete===false));
});

test('replay rejects missing transitions, altered peaks, scopes, endpoints and acknowledgment identities',async t=>{
 const {result}=await fixture(t);
 const cases=[
  ['omitted transient',e=>{e.window.rows.splice(0,1);e.window.transitionCount--;e.window.final.sequence--;for(const [index,row]of e.window.rows.entries())row.sequence=index+1;e.window.peakCpu.sequence--;},/missing or duplicated allocation transition/],
  ['sum of independent peaks',e=>{e.window.peakCpu.bytes=420+727;},/peak replay mismatch/],
  ['changed row amount',e=>{e.window.rows[3].cpu[4]++;},/peak replay mismatch/],
  ['duplicate sequence',e=>{e.window.rows[1].sequence=1;},/transition order/],
  ['CPU subset',e=>{e.window.cpuKinds[4]='canvas';},/CPU attribution scope/],
  ['invented endpoint',e=>{e.window.final.poolTextBytes=1;},/final owner amounts or sequences differ/],
  ['wrong begin epoch',e=>{e.begin.ledgerInstanceId='stale-realm';},/window acknowledgment binding/],
  ['empty ledger identity',e=>{e.window.ledgerInstanceId='';},/window identity/],
  ['arbitrary ledger identity',e=>{e.window.ledgerInstanceId='ledger-1';},/window identity/],
  ['wrong end clock',e=>{e.end.clockOriginMs++;},/window acknowledgment binding/],
  ['contradictory complete',e=>{e.window.failures=['row-limit'];},/contradictory complete flag/],
  ['extra point key',e=>{e.window.rows[0].rssBytes=0;},/point keys/],
  ['unsafe byte count',e=>{e.window.rows[0].cpu[0]=Number.MAX_SAFE_INTEGER+1;},/point amount or clock/],
  ['wrong observer attempt',e=>{e.binding.observerId='text-00000000-0000-0000-0000-000000000000';},/attempt observer\/window identity/],
 ];
 for(const [name,mutate,error]of cases){const evidence=structuredClone(result.evidence);mutate(evidence);assert.throws(()=>replayTextResourceEvidence(evidence),error,name);}
});

test('retained verification rejects hash, byte-count, UTF-8 and oversized-artifact tampering before issuing proof',async t=>{
 const f=await fixture(t);
 await assert.rejects(verify(f,{artifact:{...f.result.artifact,sha256:'sha256:'+'0'.repeat(64)}}),/retained artifact hash\/length/);
 await assert.rejects(verify(f,{artifact:{...f.result.artifact,bytes:f.result.artifact.bytes+1}}),/retained artifact hash\/length/);
 await assert.rejects(verify(f,{artifact:{...f.result.artifact,path:'relative.json'}}),/artifact identity/);
 await assert.rejects(verify(f,{artifact:{...f.result.artifact,bytes:8*1048576+1}}),/artifact identity/);
 const invalid=Buffer.from([0xff]);
 await assert.rejects(verify(f,{artifact:{...f.result.artifact,bytes:invalid.length,sha256:hash(invalid)},readRetained:async()=>invalid}),/encoded data|encoding|UTF-8/i);
});

test('retained artifact identity is inseparable from the one actual intent, begin and final journal bracket',async t=>{
 const f=await fixture(t),events=f.journalEvents;
 for(const event of ['text-resources-intent','text-resources-begin','text-resources-observed']){
  await assert.rejects(verify(f,{journalEvents:events.filter(row=>row.event!==event)}),/single actual/);
  await assert.rejects(verify(f,{journalEvents:[...events,structuredClone(events.find(row=>row.event===event))]}),/single actual/);
 }
 const altered=structuredClone(events);altered[2].artifact.sha256='sha256:'+'1'.repeat(64);
 await assert.rejects(verify(f,{journalEvents:altered}),/final journal binding/);
 const wrongTime=structuredClone(events);wrongTime[0].startedMs++;
 await assert.rejects(verify(f,{journalEvents:wrongTime}),/single actual intent journal binding/);
 const wrongAck=structuredClone(events);wrongAck[1].begin.ordinal++;
 await assert.rejects(verify(f,{journalEvents:wrongAck}),/begin journal binding/);
 await assert.rejects(verify(f,{journalEvents:undefined}),/actual producer journal required/);
});

test('retained bindings reject stale cell, process, fixture, source, sample and cycle identities',async t=>{
 const f=await fixture(t),binding=f.result.evidence.binding;
 for(const mutation of [
  {cellId:'other-cell'},{operation:'text.apply'},{processIdentity:'different-process'},
  {fixtureIdentity:'sha256:'+'a'.repeat(64)},{executableIdentity:{kind:'different-source'}},
  {sample:{cache:'warm',ordinal:1,prime:false}},{serial:2},{cycleOrdinal:2},
 ])await assert.rejects(verify(f,{binding:{...binding,...mutation}}),/cell\/cycle\/fixture\/process\/source binding/);
});

test('plain, serialized, cloned and result-mutated proof objects cannot manufacture complete measurements',async t=>{
 const f=await fixture(t),{result}=f;
 for(const proof of [{},structuredClone(result.proof),JSON.parse(JSON.stringify(result.proof)),{complete:true,measurements:[{name:rule.name,value:0,complete:true}]}]){
  const answer=textResourceMeasurement({cell,sample,rule,proof});assert.equal(answer.measurement,undefined);assert.match(answer.reason,/issuer is unavailable/);
 }
 result.complete=true;result.missing.length=0;for(const row of result.measurements){row.complete=true;row.value=0;}
 const original=textResourceMeasurement({cell,sample,rule,proof:result.proof});assert.equal(original.measurement,undefined);assert.match(original.reason,/exact-text-resource-source-native-runtime-review-unavailable/);
 assert.match(textResourceMeasurement({cell,sample:{...sample,ordinal:2},rule,proof:result.proof}).reason,/issuer is unavailable/);
 assert.match(textResourceMeasurement({cell:{...cell,operation:'text.apply'},sample,rule,proof:result.proof}).reason,/issuer is unavailable/);
 for(const invalidRule of [{...rule,budgetId:'R1'},{...rule,name:'AppCpuBytes'},{...rule,unit:'MiB'}])assert.match(textResourceMeasurement({cell,sample,rule:invalidRule,proof:result.proof}).reason,/Invalid R35/);
});

test('caller supplied renderer claims do not qualify zero glyph bookings or bypass executable identity',async t=>{
 const {result}=await fixture(t),evidence=structuredClone(result.evidence);
 evidence.rendererOwnershipProof={complete:true,cpuBytes:true,gpuBytes:true,executableIdentity:evidence.binding.executableIdentity};
 const value=replayTextResourceEvidence(evidence);assert.equal(value.complete,false);assert(value.measurements.every(row=>row.complete===false));
 assert(value.missing.includes('exact-text-resource-source-native-runtime-review-unavailable'));
 assert.throws(()=>replayTextResourceEvidence(evidence,{rendererOwnershipProof:null}),/renderer proof substitution/);
 evidence.rendererOwnershipProof.executableIdentity={kind:'substituted-executable'};
 assert.throws(()=>replayTextResourceEvidence(evidence),/renderer proof executable identity/);
});

test('mixed-ready evidence cannot relabel an explicit window or reuse the prior font authority realm',async t=>{
 const {result}=await fixture(t);
 const relabeled=structuredClone(result.evidence);relabeled.binding.operation='text.mixed-ready';
 assert.throws(()=>replayTextResourceEvidence(relabeled),/explicit stable-realm window/);
 const startup=structuredClone(relabeled),w=startup.window;
 w.id='startup-'+w.ledgerInstanceId;startup.begin.id=w.id;startup.end.id=w.id;
 startup.realm={mode:'new-realm-startup',prior:{ledgerInstanceId:w.ledgerInstanceId,clockOriginMs:w.clockOriginMs},navigations:[startup.timing.startedMs]};
 assert.throws(()=>replayTextResourceEvidence(startup),/fresh native font authority realm/);
 startup.realm.prior={ledgerInstanceId:(w.ledgerInstanceId[0]==='0'?'1':'0')+w.ledgerInstanceId.slice(1),clockOriginMs:w.clockOriginMs};
 assert.throws(()=>replayTextResourceEvidence(startup),/fresh native font authority realm/);
 startup.realm.prior.clockOriginMs=w.clockOriginMs-1;
 for(const navigations of [[],[startup.timing.startedMs,startup.timing.endedMs],[startup.timing.endedMs+1]]){
  startup.realm.navigations=navigations;assert.throws(()=>replayTextResourceEvidence(startup),/actual single main-frame navigation/);
 }
});


test('actual journal overflow survives retained replay only as incomplete bounded evidence',async t=>{
 const f=await fixture(t,{overflow:true}),window=f.result.evidence.window;
 assert.equal(window.rows.length,4096);assert.equal(window.transitionCount,4106);assert.equal(window.dropped,10);
 assert.equal(window.observationComplete,false);assert(window.failures.includes('row-limit'));
 assert.equal(window.peakCpu.bytes,2050);
 const verified=await verify(f);assert.equal(verified.complete,false);
 assert.equal(verified.measurements[0].value,2050);assert(verified.missing.includes('text-resource-transition-window-incomplete'));
 assert.equal(textResourceMeasurement({cell,sample,rule,proof:verified.proof}).measurement,undefined);
 const forged=structuredClone(f.result.evidence);forged.window.observationComplete=true;
 assert.throws(()=>replayTextResourceEvidence(forged),/contradictory complete flag/);
});

test('actual glyph bookings remain visible and cannot qualify the reviewed-software-renderer zero rule',async t=>{
 const {result}=await fixture(t,{glyphGpuBytes:9}),value=replay(result);
 assert.equal(result.evidence.window.observationComplete,true);assert.equal(value.measurements[1].value,9);
 assert.equal(value.measurements[1].complete,false);assert(value.missing.includes('glyph-bookings-conflict-with-reviewed-software-renderer'));
 const answer=textResourceMeasurement({cell,sample,rule:{...rule,name:'R35GlyphGpuBytes'},proof:result.proof});
 assert.equal(answer.measurement,undefined);assert.match(answer.reason,/glyph-bookings-conflict/);
});


test('a real shared-owner bound above 128 MiB retains its raw peak but cannot become an attributed R35 CPU metric',async t=>{
 const controlBytes=128*1048576+1,f=await fixture(t,{controlBytes}),window=f.result.evidence.window;
 assert.equal(window.observationComplete,true);assert.equal(window.transitionCount,8);
 assert.deepEqual(window.peakCpu,{bytes:controlBytes,sequence:7});
 assert.equal(window.rows[6].cpu[2],controlBytes);assert.equal(window.final.cpu[2],0);
 const retained=JSON.parse(f.retained.toString('utf8'));assert.deepEqual(retained.window.peakCpu,window.peakCpu);
 const value=replay(f.result),verified=await verify(f);
 for(const result of [f.result,value,verified]){
  assert.equal(result.complete,false);assert.equal(result.measurements.some(row=>row.name==='R35FontShapingCpuBytes'),false);
  assert(result.missing.includes('conservative-shared-owner-upper-bound-exceeds-r35-ceiling-attribution-required'));
  const glyph=result.measurements.find(row=>row.name==='R35GlyphGpuBytes');assert(glyph);assert.equal(glyph.value,0);assert.equal(glyph.complete,false);
  assert(result.missing.includes('exact-text-resource-source-native-runtime-review-unavailable'));
 }
 assert.deepEqual(verified.evidence.window.peakCpu,window.peakCpu);
 const answer=textResourceMeasurement({cell,sample,rule,proof:verified.proof});
 assert.equal(answer.measurement,undefined);assert.match(answer.reason,/conservative-shared-owner-upper-bound-exceeds-r35-ceiling-attribution-required/);
});


test('a dropped actual final owner remains a retained lower bound and declared partial peaks must include it',async t=>{
 const f=await fixture(t,{overflow:true,finalBytes:5000,finalGlyphGpuBytes:9}),window=f.result.evidence.window;
 assert.equal(window.observationComplete,false);assert.equal(window.rows.length,4096);
 assert.equal(window.transitionCount,4107);assert.equal(window.dropped,11);
 assert.equal(window.final.cpu[0],5000);assert.equal(window.final.glyphGpuBytes,9);
 const replayed=replayTextResourceWindow(window);
 assert.equal(replayed.complete,false);assert.equal(replayed.points.length,4098);
 assert.deepEqual(replayed.points.at(-1),window.final);
 assert.deepEqual(replayed.peakCpu,{bytes:5000,sequence:4107});
 assert.deepEqual(replayed.peakGlyphGpu,{bytes:9,sequence:4107});
 const verified=await verify(f);assert.equal(verified.complete,false);
 assert(verified.missing.includes('text-resource-transition-window-incomplete'));
 assert(verified.measurements.every(row=>row.complete===false));
 assert.equal(textResourceMeasurement({cell,sample,rule,proof:verified.proof}).measurement,undefined);
 for(const metric of ['peakCpu','peakGlyphGpu']){
  const forged=structuredClone(window);forged[metric].bytes--;
  assert.throws(()=>replayTextResourceWindow(forged),/partial peak below retained observation/);
 }
 for(const mutate of [w=>w.final.cpu[0]++,w=>w.final.glyphGpuBytes++]){
  const forged=structuredClone(window);mutate(forged);
  assert.throws(()=>replayTextResourceWindow(forged),/partial peak below retained observation/);
 }
});

// Only the page transport/realm metadata is a deterministic boundary specimen.
// Resource rows, transitions, acknowledgments and snapshot release are supplied
// by actual AllocationLedger/MemoryPool instances. This is not native evidence.
import {createContext,runInContext} from 'node:vm';
async function portableResourceFixture(t,{prior='blank',operation='portable.reopen',sampleValue=sample,serialValue=1}={}){
 const identity='portable-resource-campaign-'+ ++serial,{allocationsURL,diagnosticMemoryURL}=await isolatedDiagnosticModules();
 const contractsURL=await stagedModuleURL('src/text/contracts.ts',{},identity),budgetURL=await stagedModuleURL('src/protocol/text-budget.ts',{},identity);
 const admissionURL=await stagedModuleURL('src/text/admission.ts',{'./contracts':contractsURL},identity),profile=JSON.parse(await readStagedSource('src/text/profile.json'));
 const memoryURL=await stagedModuleURL('src/text/memory.ts',{
  '../observability/diagnostic-memory.js':diagnosticMemoryURL,'./contracts':contractsURL,'./admission':admissionURL,
  '../protocol/text-budget':budgetURL,'./profile.json':data('const profile='+JSON.stringify(profile)+';export default profile;export const engine=profile.engine;'),
 },identity);
 const {MemoryPool}=await import(memoryURL),{AllocationLedger}=await import(allocationsURL);
 const pool=new MemoryPool();let clock=10;const ledger=new AllocationLedger(undefined,()=>++clock);
 ledger.observeTextReservations(()=>pool.snapshot.textBytes,pool);
 const startup=ledger.textResourceStartupIdentity(),output=await mkdtemp(join(tmpdir(),'ideogram-portable-resource-'));
 t.after(()=>rm(output,{recursive:true,force:true}));
 const counts={evaluates:0,snapshots:0,releases:0,disposals:0,seals:0};
 const api={textResourceStartupIdentity:()=>ledger.textResourceStartupIdentity(),
  sealTextResourceStartupWindow(){counts.seals++;return ledger.sealTextResourceStartupWindow();},
  readTextResourceSnapshot(){counts.snapshots++;let live=true;return {value:ledger.copyTextResourceObservation(),release(){if(live){live=false;counts.releases++;}}};},
 };
 const oldLedger='cccccccc-cccc-4ccc-8ccc-cccccccccccc',oldOrigin=startup.clockOriginMs-1;
 const priorIdentity={ledgerInstanceId:oldLedger,clockOriginMs:oldOrigin,begin:{id:'startup-'+oldLedger,ordinal:1},ended:true};
 const realm=createContext({location:{href:prior==='blank'?'about:blank':'http://127.0.0.1/editor'},performance:{timeOrigin:oldOrigin,now:()=>++clock}});
 runInContext('globalThis.window=globalThis;window.top=window',realm);
 if(prior==='loaded')realm.__IDEOGRAM_PHASES__={textResourceStartupIdentity:()=>priorIdentity};
 const frame={},listeners=new Set();
 function evaluateRaw(fn,arg){counts.evaluates++;realm.__argument=arg;try{return runInContext('('+fn.toString()+')(__argument)',realm);}finally{delete realm.__argument;}}
 const page={mainFrame:()=>frame,on(event,fn){assert.equal(event,'framenavigated');listeners.add(fn);},off(event,fn){assert.equal(event,'framenavigated');listeners.delete(fn);},
  async evaluate(fn,arg){return structuredClone(evaluateRaw(fn,arg));},
  async evaluateHandle(fn,arg){const owner=evaluateRaw(fn,arg);return {async evaluate(project){return project(owner);},async dispose(){counts.disposals++;}};},
 };
 const journalEvents=[],portableCell={id:'portable-resource-original-action',operation};
 const observer=createTextResourceObserver({page,cell:portableCell,sample:sampleValue,serial:serialValue,fixtureIdentity:hash(Buffer.from('portable-fixture')),
  processIdentity:{pid:123,startIdentity:'isolated-portable-test'},executableIdentity:{kind:'unreviewed-test-executable'},output,
  journal:async event=>journalEvents.push(structuredClone(event)),
 });
 function navigate(){realm.location.href='http://127.0.0.1/editor';realm.performance.timeOrigin=startup.clockOriginMs;realm.__IDEOGRAM_PHASES__=api;for(const fn of listeners)fn(frame);}
 function subframe(){for(const fn of listeners)fn({});}
 async function retained(result){const bytes=await readFile(result.artifact.path);return {result,retained:bytes,journalEvents,readRetained:async(path,{maximum})=>{assert.equal(path,result.artifact.path);assert.equal(maximum,8*1048576);return bytes;}};}
 return {observer,ledger,pool,realm,api,page,priorIdentity,counts,listeners,navigate,subframe,retained,journalEvents};
}

for(const prior of ['blank','loaded'])test('portable '+prior+' prior keeps the real startup window live through the original endpoint and final seal',async t=>{
 const f=await portableResourceFixture(t,{prior,sampleValue:prior==='loaded'?{cache:'warm',ordinal:2,prime:false}:sample,serialValue:prior==='loaded'?3:1});
 await assert.rejects(f.observer.checkpoint(),/active observer/);assert.equal(f.counts.evaluates,0);
 const start=await f.observer.begin();assert.deepEqual(await f.observer.begin(),start);assert.equal(f.listeners.size,1);
 f.subframe();f.navigate();
 const font=f.ledger.reserve({owner:'portable-open-font',kind:'font',cpuBytes:420});font.release();
 const text=f.pool.reserve(77);let staging;
 try{
  const checkpoint=await f.observer.checkpoint();assert.equal(checkpoint.ended,false);assert.equal(f.counts.seals,0);
  assert.equal(f.ledger.textResourceStartupIdentity().ended,false);
  // A caller cannot mutate the observer's retained checkpoint through its return.
  checkpoint.windowOrdinal=999;
  staging=f.ledger.reserve({owner:'composition-after-portable-endpoint',kind:'staging',cpuBytes:650});staging.release();staging=null;text.release();
  const result=await f.observer.finish();assert.equal(await f.observer.finish(),result);
  assert.equal(result.evidence.realm.prior.documentKind,prior==='blank'?'about:blank':'application');
  assert.equal(result.evidence.realm.prior.phaseOwnerPresent,prior!=='blank');
  assert.equal(result.evidence.realm.navigations.length,1);assert.equal(result.evidence.realm.checkpoint.windowOrdinal,result.evidence.window.ordinal);
  assert.deepEqual(result.evidence.realm.failures,[]);assert.equal(result.evidence.window.observationComplete,true);
  assert(result.evidence.window.rows.some(row=>row.atMs>result.evidence.realm.checkpoint.atMs));
  assert.deepEqual(result.evidence.window.peakCpu,{bytes:727,sequence:4});
  assert(result.evidence.window.final.atMs>=result.evidence.realm.checkpoint.atMs);
  assert.deepEqual(f.journalEvents.map(row=>row.event),['text-resources-intent','text-resources-checkpoint','text-resources-begin','text-resources-observed']);
  assert.equal(f.counts.snapshots,1);assert.equal(f.counts.releases,1);assert.equal(f.counts.disposals,1);assert.equal(f.listeners.size,0);
  const verified=await verify(await f.retained(result));assert.equal(verified.complete,false);
  assert.deepEqual(verified.missing,['exact-text-resource-source-native-runtime-review-unavailable']);
  await assert.rejects(f.observer.checkpoint(),/active observer/);
 }finally{staging?.release();text.release();}
});

test('portable prior capture refuses non-top-level, missing owner and invalid loaded identities before attaching or journaling',async t=>{
 for(const change of [
  f=>{f.realm.window.top={};},
  f=>{delete f.realm.__IDEOGRAM_PHASES__;},
  f=>{f.realm.__IDEOGRAM_PHASES__={};},
  f=>{f.priorIdentity.ledgerInstanceId='invalid';},
  f=>{f.priorIdentity.clockOriginMs++;},
  f=>{f.priorIdentity.begin.id='startup-wrong';},
 ]){
  const f=await portableResourceFixture(t,{prior:'loaded'});change(f);
  await assert.rejects(f.observer.begin(),/PORTABLE_TEXT_RESOURCE|portable.*realm/i);
  assert.equal(f.listeners.size,0);assert.deepEqual(f.journalEvents,[]);assert.equal(f.counts.seals,0);
 }
 const f=await portableResourceFixture(t);f.realm.__IDEOGRAM_PHASES__={};
 await assert.rejects(f.observer.begin(),/PORTABLE_TEXT_RESOURCE|portable.*realm/i);
 assert.equal(f.listeners.size,0);assert.deepEqual(f.journalEvents,[]);
});

test('portable missing endpoint and original endpoint read failure retain distinct incomplete evidence without retrying a read',async t=>{
 for(const mode of ['missing','pending-navigation','wrong-clock']){
  const f=await portableResourceFixture(t);await f.observer.begin();
  if(mode==='pending-navigation')assert.equal(await f.observer.checkpoint(),null);
  f.navigate();
  if(mode==='wrong-clock'){
   const original=f.api.textResourceStartupIdentity;f.api.textResourceStartupIdentity=()=>({...original(),clockOriginMs:f.realm.performance.timeOrigin+1});
   assert.equal(await f.observer.checkpoint(),null);f.api.textResourceStartupIdentity=original;
  }
  const result=await f.observer.finish({failed:mode==='pending-navigation'});
  assert.equal(result.evidence.realm.checkpoint,null);
  assert.deepEqual(result.evidence.realm.failures,[mode==='missing'?'checkpoint-missing':'checkpoint-unavailable']);
  assert.equal(f.journalEvents.some(row=>row.event==='text-resources-checkpoint'),false);
  const verified=await verify(await f.retained(result));assert.equal(verified.complete,false);
  assert(verified.missing.includes('portable-text-resource-original-action-endpoint-unavailable'));
  if(mode==='pending-navigation')assert(verified.missing.includes('text-resource-action-failed'));
  assert.equal(f.counts.snapshots,1);assert.equal(f.counts.releases,1);assert.equal(f.listeners.size,0);
 }
});

test('portable pending endpoint read rejects duplication and retains exactly one checkpoint after settlement',async t=>{
 const f=await portableResourceFixture(t);await f.observer.begin();f.navigate();
 const original=f.page.evaluate;let release,entered;
 const barrier=new Promise(resolve=>{release=resolve;}),readEntered=new Promise(resolve=>{entered=resolve;});
 f.page.evaluate=async function(fn,arg){let value;try{value=await original.call(this,fn,arg);}finally{entered();}await barrier;return value;};
 const settled=f.observer.checkpoint().then(value=>({value}),error=>({error}));
 try{
  await readEntered;const reads=f.counts.evaluates;
  await assert.rejects(f.observer.checkpoint(),/checkpoint repeated/);assert.equal(f.counts.evaluates,reads);
  assert.equal(f.journalEvents.some(row=>row.event==='text-resources-checkpoint'),false);
 }finally{release();await settled;f.page.evaluate=original;}
 const endpoint=await settled;assert.equal(endpoint.error,undefined);assert.equal(endpoint.value.ended,false);
 const result=await f.observer.finish();assert.deepEqual(result.evidence.realm.failures,['checkpoint-repeated']);
 assert.equal(f.journalEvents.filter(row=>row.event==='text-resources-checkpoint').length,1);
 assert((await verify(await f.retained(result))).missing.includes('portable-text-resource-original-action-endpoint-unavailable'));
});

test('portable already-sealed endpoint and repeated main navigation preserve raw failure bytes and release snapshots',async t=>{
 for(const mode of ['sealed','second-navigation']){
  const f=await portableResourceFixture(t);await f.observer.begin();f.navigate();
  if(mode==='sealed')f.ledger.sealTextResourceStartupWindow();
  await f.observer.checkpoint();if(mode==='second-navigation')f.navigate();
  let failure;try{await f.observer.finish();assert.fail('invalid portable boundary must reject');}catch(error){failure=error;}
  assert(failure.textResourceArtifact);const raw=JSON.parse(await readFile(failure.textResourceArtifact.path,'utf8'));
  assert.equal(raw.realm.checkpoint.ended,mode==='sealed');assert.equal(raw.realm.navigations.length,mode==='sealed'?1:2);
  assert.equal(f.counts.snapshots,1);assert.equal(f.counts.releases,1);assert.equal(f.counts.disposals,1);assert.equal(f.listeners.size,0);
  await assert.rejects(f.observer.finish(),/already closed/);
 }
});

test('portable replay refuses stale realms, changed endpoint identities and final windows that fail to cover the original action',async t=>{
 const f=await portableResourceFixture(t,{prior:'loaded'});await f.observer.begin();f.navigate();await f.observer.checkpoint();const result=await f.observer.finish();
 const priorStillOpen=structuredClone(result.evidence);priorStillOpen.realm.prior.ended=false;assert.equal(replayTextResourceEvidence(priorStillOpen).complete,false);
 for(const change of [
  e=>{e.realm.prior.ledgerInstanceId=e.window.ledgerInstanceId;e.realm.prior.windowId=e.window.id;},
  e=>{e.realm.prior.clockOriginMs=e.window.clockOriginMs;},
  e=>{e.realm.prior.phaseOwnerPresent=false;},
  e=>{e.realm.checkpoint.ledgerInstanceId=e.realm.prior.ledgerInstanceId;},
  e=>{e.realm.checkpoint.clockOriginMs++;},
  e=>{e.realm.checkpoint.windowId='startup-'+e.realm.prior.ledgerInstanceId;},
  e=>{e.realm.checkpoint.windowOrdinal++;},
  e=>{e.realm.checkpoint.ended=true;},
  e=>{e.realm.checkpoint.atMs=e.window.final.atMs+1;},
  e=>{e.realm.checkpoint.startedMs=e.realm.navigations[0]-1;},
  e=>{e.realm.checkpoint.endedMs=e.timing.endedMs+1;},
  e=>{e.binding.operation='text.mixed-ready';},
 ]){const raw=structuredClone(result.evidence);change(raw);assert.throws(()=>replayTextResourceEvidence(raw),/portable|realm/);}
});

test('portable artifact replay requires one exact original endpoint journal and cannot repair a missing endpoint with an invented row',async t=>{
 const f=await portableResourceFixture(t);await f.observer.begin();f.navigate();await f.observer.checkpoint();const result=await f.observer.finish(),value=await f.retained(result);
 const row=value.journalEvents.find(event=>event.event==='text-resources-checkpoint');
 for(const events of [value.journalEvents.filter(event=>event!==row),[...value.journalEvents,structuredClone(row)],
  value.journalEvents.map(event=>event===row?{...event,checkpoint:{...event.checkpoint,windowOrdinal:999}}:event),
  value.journalEvents.map(event=>event===row?{...event,binding:{...event.binding,serial:999}}:event)]){
  await assert.rejects(verify(value,{journalEvents:events}),/single actual portable checkpoint journal binding/);
 }
 const g=await portableResourceFixture(t);await g.observer.begin();g.navigate();const missing=await g.observer.finish(),missingValue=await g.retained(missing);
 const invented={...row,observerId:missing.evidence.binding.observerId,binding:missing.evidence.binding};
 await assert.rejects(verify(missingValue,{journalEvents:[...missingValue.journalEvents,invented]}),/single actual portable checkpoint journal binding/);
});

test('the portable checkpoint API does not acquire a page snapshot for an explicit-window observer',async t=>{
 const f=await portableResourceFixture(t,{operation:'text.font-set'});
 await assert.rejects(f.observer.checkpoint(),/active observer/);assert.equal(f.counts.evaluates,0);assert.equal(f.counts.snapshots,0);
});

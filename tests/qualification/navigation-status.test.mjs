import test from 'node:test';
import assert from 'node:assert/strict';
import {allocationsURL,browserPhasesURL,phasesURL,navigationObservationsURL,diagnosticMemoryURL} from '../owned-preview-module.mjs';

// Resolve the same real diagnostic/phase/allocation graph as production fixtures.
// No fake ledger, browser snapshot, or alternate copy path supplies these rows.
const {BrowserPhases,NAVIGATION_STATUS_BYTES}=await import(browserPhasesURL);
const {PhaseRecorder,PHASE_ROW_BYTES}=await import(phasesURL);
const {NAVIGATION_OBSERVATION_BYTES}=await import(navigationObservationsURL);
const {diagnosticPayloadBytes}=await import(diagnosticMemoryURL);
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL);
const sourceId='3e37ad41-a56a-41e5-9667-35eb24ddeac6',origin=1_800_000_000_000.25;
const common={sourceId,lifecycle:0,documentGeneration:0,sessionId:'editor_null',documentId:null,revision:null,cursor:'0'};
const state=(changes={})=>({...common,message:'Connect locally to open your work.',ready:false,busy:false,hasError:false,hasRecovery:false,...changes});
const authority=(changes={})=>({...common,kind:'recovered',...changes});
const allocationKeys=['cpuBytes','gpuBytes','previewCacheBytes','handles','unusedHandles','activeRecords'];
const point=()=>Object.fromEntries(allocationKeys.map(key=>[key,allocationLedger.snapshot()[key]]));
function fixture(t){
 const baseline=point(),held=[];let now=100;
 const recorder=new PhaseRecorder({lane:'navigation-status-test',capacity:2,openSpans:2,now:()=>now,wallNow:()=>origin+now});
 const beforeBrowser=point(),browser=new BrowserPhases(()=>now,recorder,origin);
 t.after(()=>{for(const read of held)read.release();browser.dispose();recorder.dispose();assert.deepEqual(point(),baseline,'all fixture-owned diagnostic roots and reads are released');});
 return {browser,recorder,beforeBrowser,hold(read){held.push(read);return read;},now(value){now=value;}};
}
function snapshot(browser){const owner=browser.readSnapshot();try{return structuredClone(owner.value.navigationStatus);}finally{owner.release();}}

test('navigation history maps only exact status literals and deduplicates consecutive state tuples',t=>{
 const f=fixture(t),messages=[
  ['Connect locally to open your work.','connect'],
  ['Recovering complete local transactions…','recovering'],
  ['Local recovery complete. Accepted edits are saved locally.','recovered'],
  ['Open local document…','opening'],
  ['Local document opened.','opened'],
  ['Save checkpoint…','saving'],
  ['SaveCheckpoint accepted and saved locally.','saved'],
 ];
 for(let index=0;index<messages.length;index++){
  f.now(100+index*2);f.browser.recordNavigationStatus(state({message:messages[index][0]}));
  f.now(101+index*2);f.browser.recordNavigationStatus(state({message:messages[index][0]}));
 }
 const first=snapshot(f.browser);
 assert.deepEqual(first,{kind:'navigation-status-1',timeOriginMs:origin,capacity:128,dropped:0,invalid:0,closed:false,
  rows:messages.map(([,status],index)=>({...common,sequence:index+1,atMs:100+index*2,kind:'state',status,ready:false,busy:false,hasError:false,hasRecovery:false}))});
 f.now(120);f.browser.recordNavigationStatus(state({message:'Local document opened. '}));
 f.now(121);f.browser.recordNavigationStatus(state({message:'private prompt '.repeat(1000)}));
 assert.equal(snapshot(f.browser).rows.length,8,'different unknown messages share only the safe other tuple');
 for(const [index,key] of ['ready','busy','hasError','hasRecovery'].entries()){
  f.now(122+index);f.browser.recordNavigationStatus(state({message:'private', [key]:true}));
 }
 const result=snapshot(f.browser);assert.equal(result.rows.length,12);
 assert.equal(JSON.stringify(result).includes('private'),false);assert.equal(JSON.stringify(result).includes('message'),false);
});

test('all authority events and intervening publication identities survive both navigation resets',t=>{
 const f=fixture(t),opened={...common,lifecycle:1,documentGeneration:1,sessionId:'ui_session',documentId:'doc-1',revision:'4',cursor:'9'};
 f.browser.recordNavigationStatus(state());
 f.now(101);f.browser.recordNavigationAuthority(authority());
 f.now(102);f.browser.recordNavigationAuthority(authority());
 f.browser.resetNavigation();f.browser.reset();
 f.now(103);f.browser.recordNavigationStatus(state({...opened,message:'Local document opened.',ready:true}));
 f.now(104);f.browser.recordNavigationAuthority({...opened,kind:'opened'});
 f.now(105);f.browser.recordNavigationStatus(state({...opened,message:'Local document opened.',ready:true}));
 f.now(106);f.browser.recordNavigationAuthority({...opened,kind:'checkpoint',commandId:'command-1',transactionId:'transaction-1',fromSeq:'10',toSeq:'12'});
 f.now(107);f.browser.recordNavigationStatus(state({...opened,sourceId:'5914b14e-6a4b-429e-80c6-fa7328c24e44',message:'Local document opened.',ready:true}));
 const history=snapshot(f.browser);
 assert.deepEqual(history.rows.map(row=>row.kind),['state','recovered','recovered','state','opened','state','checkpoint','state']);
 assert.deepEqual(history.rows.map(row=>row.sequence),[1,2,3,4,5,6,7,8]);
 assert.deepEqual(history.rows.map(row=>row.atMs),[100,101,102,103,104,105,106,107]);
 assert.deepEqual(history.rows[6],{...opened,sequence:7,atMs:106,kind:'checkpoint',commandId:'command-1',transactionId:'transaction-1',fromSeq:'10',toSeq:'12'});
 assert.equal(history.closed,false);assert.equal(history.rows[7].sourceId,'5914b14e-6a4b-429e-80c6-fa7328c24e44');
});

test('maximum admitted identities retain exact checkpoint values within the reserved row payload',t=>{
 const f=fixture(t),maximum={...common,lifecycle:Number.MAX_SAFE_INTEGER,documentGeneration:Number.MAX_SAFE_INTEGER,sessionId:'s'.repeat(128),documentId:'d'.repeat(128),revision:'9'.repeat(128),cursor:'9'.repeat(128),kind:'checkpoint',commandId:'c'.repeat(128),transactionId:'t'.repeat(128),fromSeq:'8'.repeat(128),toSeq:'9'.repeat(128)};
 f.browser.recordNavigationAuthority(maximum);
 const history=snapshot(f.browser);assert.equal(history.invalid,0);assert.equal(history.rows.length,1);
 assert.deepEqual(history.rows[0],{...maximum,sequence:1,atMs:100});
 assert.ok(diagnosticPayloadBytes(history.rows[0])+2<=16384);
 assert.ok(diagnosticPayloadBytes(history)<=4096+diagnosticPayloadBytes(history.rows[0])+2);
 maximum.commandId='changed';maximum.cursor='0';assert.equal(snapshot(f.browser).rows[0].commandId,'c'.repeat(128));
});

test('capacity keeps the complete first128 rows and closes permanently on the first undeduplicated overflow',t=>{
 const f=fixture(t);
 for(let index=0;index<128;index++){f.now(100+index);f.browser.recordNavigationStatus(state({busy:index%2===1}));}
 const full=snapshot(f.browser);assert.equal(full.rows.length,128);assert.equal(full.closed,false);
 f.now(228);f.browser.recordNavigationStatus(state({busy:true}));assert.deepEqual(snapshot(f.browser),full,'same consecutive state is not a dropped publication');
 f.now(229);f.browser.recordNavigationAuthority(authority());
 const overflow=snapshot(f.browser);assert.equal(overflow.dropped,1);assert.equal(overflow.invalid,0);assert.equal(overflow.closed,true);assert.deepEqual(overflow.rows,full.rows);
 f.browser.resetNavigation();f.browser.reset();f.browser.recordNavigationStatus(state());f.browser.recordNavigationAuthority(authority());
 assert.deepEqual(snapshot(f.browser),overflow,'reset and later good observations cannot repair a truncated page history');
});

test('malformed observer inputs fail closed without throwing or retaining raw values',async t=>{
 const mutations=[
  ['source UUID',value=>({...value,sourceId:'not-a-uuid'})],
  ['session null',value=>({...value,sessionId:null})],
  ['session over bound',value=>({...value,sessionId:'s'.repeat(129)})],
  ['document over bound',value=>({...value,documentId:'d'.repeat(129),revision:'1'})],
  ['partial document identity',value=>({...value,documentId:'doc-1'})],
  ['negative lifecycle',value=>({...value,lifecycle:-1})],
  ['fractional generation',value=>({...value,documentGeneration:0.5})],
  ['unsafe generation',value=>({...value,documentGeneration:Number.MAX_SAFE_INTEGER+1})],
  ['oversize cursor',value=>({...value,cursor:'1'.repeat(129)})],
  ['noncanonical cursor',value=>({...value,cursor:'01'})],
  ['boolean coercion',value=>({...value,ready:'true'})],
  ['message object',value=>({...value,message:{private:'never retained'}})],
  ['inherited field',value=>{const result={...value};delete result.cursor;return Object.assign(Object.create({cursor:'0'}),result);}],
  ['null input',()=>null],
 ];
 for(const ending of ['\n','\r','\r\n','\u2028','\u2029'])for(const key of ['sourceId','sessionId','cursor'])mutations.push([key+' terminal '+JSON.stringify(ending),value=>({...value,[key]:value[key]+ending})]);
 for(const [name,change]of mutations)await t.test(name,t=>{
  const f=fixture(t);f.browser.recordNavigationStatus(state());
  assert.doesNotThrow(()=>f.browser.recordNavigationStatus(change(state())));
  const failed=snapshot(f.browser);assert.equal(failed.invalid,1);assert.equal(failed.closed,true);assert.equal(failed.dropped,0);assert.equal(failed.rows.length,1);
  f.browser.resetNavigation();f.browser.recordNavigationStatus(state({ready:true}));assert.deepEqual(snapshot(f.browser),failed);
 });
 for(const fields of [{kind:'fake'},{kind:'checkpoint',commandId:'c'.repeat(129),transactionId:'t',fromSeq:'1',toSeq:'2'},{kind:'checkpoint',commandId:'c',transactionId:'t',fromSeq:'2',toSeq:'1'}])await t.test('invalid authority '+JSON.stringify(fields),t=>{
  const f=fixture(t);assert.doesNotThrow(()=>f.browser.recordNavigationAuthority(authority(fields)));const failed=snapshot(f.browser);assert.equal(failed.closed,true);assert.equal(failed.invalid,1);assert.equal(failed.rows.length,0);
 });
});

test('fixed own-field reads never evaluate accessors or enumerate arbitrary payload keys',t=>{
 const f=fixture(t);let getters=0,enumerations=0;
 const extra=new Proxy(Object.defineProperty(state(),'private',{get(){getters++;throw Error('private getter');}}),{ownKeys(){enumerations++;throw Error('no full walk');}});
 assert.doesNotThrow(()=>f.browser.recordNavigationStatus(extra));assert.equal(snapshot(f.browser).rows.length,1);
 const invalid=Object.defineProperty(state({ready:true}),'cursor',{get(){getters++;throw Error('cursor getter');}});
 assert.doesNotThrow(()=>f.browser.recordNavigationStatus(invalid));assert.equal(getters,0);assert.equal(enumerations,0);
 const result=snapshot(f.browser);assert.equal(result.invalid,1);assert.equal(result.closed,true);assert.equal(result.rows.length,1);
});

test('explicit invalidation and reentrant publication cannot leave a success-only retained history',t=>{
 const f=fixture(t);let reentered=false;
 const input=new Proxy(state(),{getOwnPropertyDescriptor(target,key){if(!reentered){reentered=true;f.browser.recordNavigationAuthority(authority());}return Reflect.getOwnPropertyDescriptor(target,key);}});
 assert.doesNotThrow(()=>f.browser.recordNavigationStatus(input));
 const failed=snapshot(f.browser);assert.equal(failed.invalid,1);assert.equal(failed.closed,true);assert.equal(failed.rows.length,0);
 f.browser.invalidateNavigationStatus();f.browser.recordNavigationStatus(state());assert.deepEqual(snapshot(f.browser),failed);
});

test('explicit invalidation preserves the accepted prefix and cannot be reset',t=>{
 const f=fixture(t);f.browser.recordNavigationStatus(state());f.browser.invalidateNavigationStatus();f.browser.resetNavigation();
 assert.equal(snapshot(f.browser).invalid,1);assert.equal(snapshot(f.browser).closed,true);assert.equal(snapshot(f.browser).rows.length,1);
});

test('nonfinite, negative or backward observation clocks are invalid evidence, never clamped endpoints',async t=>{
 for(const time of [NaN,Infinity,-1,99])await t.test(String(time),t=>{
  const f=fixture(t);f.browser.recordNavigationStatus(state());f.now(time);
  assert.doesNotThrow(()=>f.browser.recordNavigationStatus(state({ready:true})));
  const history=snapshot(f.browser);assert.equal(history.invalid,1);assert.equal(history.closed,true);assert.deepEqual(history.rows.map(row=>row.atMs),[100]);
 });
});

test('snapshot copy remains detached and charged through extraction after producer disposal',t=>{
 const f=fixture(t);f.browser.recordNavigationStatus(state());
 const beforeRead=point(),read=f.hold(f.browser.readSnapshot('navigation-status-held'));
 assert.equal(f.browser.readSnapshot('navigation-status-held'),read);assert.ok(point().cpuBytes>beforeRead.cpuBytes);
 read.value.navigationStatus.rows[0].sessionId='copy-only';read.value.navigationStatus.rows.push({private:'copy-only'});
 assert.equal(snapshot(f.browser).rows.length,1);assert.equal(snapshot(f.browser).rows[0].sessionId,'editor_null');
 f.browser.dispose();assert.equal(read.value.navigationStatus.rows[0].sessionId,'copy-only');
 const afterDispose=point();read.release();assert.ok(point().cpuBytes<afterDispose.cpuBytes);assert.throws(()=>read.value,/DIAGNOSTIC_READ_RELEASED/);
 assert.throws(()=>f.browser.readSnapshot('new-after-dispose'),/BROWSER_PHASES_DISPOSED/);
 assert.doesNotThrow(()=>{f.browser.recordNavigationStatus(state());f.browser.recordNavigationAuthority(authority());f.browser.invalidateNavigationStatus();});
});

test('producer admission is fixed before records and rolls back on refusal or constructor failure',t=>{
 const f=fixture(t),after=point();
 assert.equal(after.cpuBytes-f.beforeBrowser.cpuBytes,68*PHASE_ROW_BYTES+65536+NAVIGATION_OBSERVATION_BYTES+NAVIGATION_STATUS_BYTES);
 assert.equal(after.activeRecords-f.beforeBrowser.activeRecords,3);
 for(let index=0;index<128;index++)f.browser.recordNavigationAuthority(authority({lifecycle:index}));
 assert.deepEqual(point(),after,'bounded retained publications require no untracked incremental owner');
 const beforeRefusal=point(),browserLease=68*PHASE_ROW_BYTES+65536;
 const fill=allocationLedger.reserve({owner:'navigation-status-admission-test',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-beforeRefusal.cpuBytes-browserLease,handles:1});
 let clocks=0;
 try{assert.throws(()=>new BrowserPhases(()=>{clocks++;return 1;},f.recorder,origin),/ALLOCATION_BUDGET/);assert.equal(clocks,0);}
 finally{fill.release();}
 assert.deepEqual(point(),beforeRefusal);
 assert.throws(()=>new BrowserPhases(()=>1,f.recorder,NaN),/NAVIGATION_CLOCK_ORIGIN/);assert.deepEqual(point(),beforeRefusal);
});

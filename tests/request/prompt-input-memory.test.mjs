// Authored source-only. The coordinator runs this after final source assembly.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transformWithOxc} from 'vite';
const root=process.env.REQUEST_PROMPT_ROOT??'.',data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function source(path,imports={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const {allocationsURL:allocationURL,promptMemoryURL:promptURL}=await import(pathToFileURL(resolve('tests/owned-preview-module.mjs')).href),modelURL=await source('src/observability/model-memory.ts',{'./allocations.js':allocationURL,'./prompt-memory.js':promptURL});
const helperURL=await source(root+'/src/ui/request-prompt-memory.ts',{'../observability/prompt-memory.js':promptURL,'../observability/allocations.js':allocationURL});
const {RequestPromptInput,registerRequestEntry,REQUEST_PROMPT_HEADROOM}=await import(helperURL),{allocationLedger,ALLOCATION_LIMITS}=await import(allocationURL),{createOwnedModel,modelPayloadBytes}=await import(modelURL);
const usage=()=>{const s=allocationLedger.snapshot();return {cpuBytes:s.cpuBytes,promptBytes:s.promptBytes,handles:s.handles,activeRecords:s.activeRecords};};
function registry(){const state={calls:0,active:0,releases:0};return {state,register(){state.calls++;state.active++;let held=true;return ()=>{assert(held,'Registration released twice');held=false;state.active--;state.releases++;};}};}
const pressure=(available=0)=>allocationLedger.reserve({owner:'prompt-input-test-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes-allocationLedger.snapshot().promptBytes-available});
function input(initial='',maximum=1024**2,registration=registry()){return {slot:new RequestPromptInput('draft','document',{},initial,maximum,()=>registration.register()),registration};}

test('an editable prompt owns headroom and its registration before any native insertion',()=>{
 const before=usage(),r=registry(),{slot}=input('saved',1024**2,r);try{assert.equal(REQUEST_PROMPT_HEADROOM,65536);assert.equal(slot.capacity,65536);assert.equal(slot.value,'saved');assert.equal(slot.maximum,1024**2);assert.equal(r.state.active,1);const during=usage();assert.equal(during.promptBytes-before.promptBytes,65536*8+1024);assert.equal(during.handles-before.handles,5);slot.capture('complete accepted native input');assert.equal(slot.value,'complete accepted native input');assert.deepEqual(usage(),during,'An input inside reserved headroom needs no new admission');}finally{slot.release();}assert.deepEqual(r.state,{calls:1,active:0,releases:1});assert.deepEqual(usage(),before);
});

for(const initial of ['😀'.repeat(40000),'raw\n東京 '.repeat(10000)])test('a recovered prompt larger than the usual headroom remains complete ('+initial.length+' UTF16 units)',()=>{
 const before=usage(),{slot}=input(initial,initial.length+10);try{assert.equal(slot.value,initial);assert.equal(slot.capacity,initial.length);assert.equal(usage().promptBytes-before.promptBytes,initial.length*8+1024);slot.admit(initial.length+2);slot.capture(initial+'😀');assert.equal(slot.value,initial+'😀');assert.equal(slot.value.length,initial.length+2);}finally{slot.release();}assert.deepEqual(usage(),before);
});

test('a smaller current Entry limit bounds native admission without splitting a surrogate pair',()=>{
 const before=usage(),{slot}=input('😀',3);try{assert.equal(slot.capacity,3);assert.throws(()=>slot.admit(4),/REQUEST_PROMPT_LIMIT/);assert.throws(()=>slot.capture('😀😀'),/REQUEST_PROMPT_NOT_ADMITTED/);assert.equal(slot.value,'😀');slot.capture('😀x');assert.equal(slot.value,'😀x');}finally{slot.release();}assert.deepEqual(usage(),before);
});

test('failed input creation releases its already-acquired draft registration',()=>{
 const before=usage(),r=registry(),block=pressure(1024),blocked=usage();try{assert.throws(()=>input('',1024**2,r),/PROMPT_MEMORY_BUDGET/);assert.deepEqual(r.state,{calls:1,active:0,releases:1});assert.deepEqual(usage(),blocked);}finally{block.release();}assert.deepEqual(usage(),before);
});

test('registration refusal happens before a prompt allowance is acquired',()=>{
 const before=usage();assert.throws(()=>new RequestPromptInput('draft','document',{},'',1024**2,()=>{throw Error('REGISTER_REFUSED');}),/REGISTER_REFUSED/);assert.deepEqual(usage(),before);
});

test('prospective growth refuses atomically and the exact insertion can be retried after capacity returns',()=>{
 const before=usage(),{slot}=input('saved');let block;try{const capacity=slot.capacity,value='a'.repeat(capacity)+'東京😀';slot.refused=true;slot.insertionRefused=true;slot.nativeOverflow=true;block=pressure();const blocked=usage();assert.throws(()=>slot.admit(value.length),/PROMPT_MEMORY_BUDGET/);assert.equal(slot.capacity,capacity);assert.equal(slot.value,'saved');assert.equal(slot.refused,true);assert.equal(slot.insertionRefused,true);assert.equal(slot.nativeOverflow,true);assert.throws(()=>slot.capture(value),/REQUEST_PROMPT_NOT_ADMITTED/);assert.deepEqual(usage(),blocked);block.release();block=null;slot.admit(value.length);assert(slot.capacity>=value.length);assert(slot.capacity<=slot.maximum);slot.capture(value);assert.equal(slot.value,value);assert.equal(slot.refused,true,'Retaining raw input does not report a saved Entry');assert.equal(slot.nativeOverflow,false);assert.equal(slot.insertionRefused,false);slot.saved(value);assert.equal(slot.refused,false);assert.equal(slot.value,value);}finally{block?.release();slot.release();}assert.deepEqual(usage(),before);
});

test('deletion and same-capacity replacement remain editable while new prompt admission is exhausted',()=>{
 const before=usage(),{slot}=input('prefix😀suffix');let block;try{block=pressure();const blocked=usage();slot.admit('prefix😀'.length);slot.capture('prefix😀');assert.equal(slot.value,'prefix😀');slot.admit('prefix東京'.length);slot.capture('prefix東京');assert.equal(slot.value,'prefix東京');assert.deepEqual(usage(),blocked);}finally{block?.release();slot.release();}assert.deepEqual(usage(),before);
});

test('changing the logical upper bound cannot invalidate retained raw input',()=>{
 const before=usage(),{slot}=input('retained');try{assert.throws(()=>slot.limit(7),/REQUEST_PROMPT_LIMIT/);assert.equal(slot.maximum,1024**2);slot.limit(8);assert.equal(slot.value,'retained');assert.equal(slot.maximum,8);assert.throws(()=>slot.admit(9),/REQUEST_PROMPT_LIMIT/);assert.throws(()=>slot.capture('retained!'),/REQUEST_PROMPT_NOT_ADMITTED/);slot.limit(32);slot.saved('retained exact retry');assert.equal(slot.value,'retained exact retry');}finally{slot.release();}assert.deepEqual(usage(),before);
});

test('native/action pins keep input allowance and registration live after the root is retired',()=>{
 const before=usage(),{slot,registration}=input('held'),releaseA=slot.pin(),releaseB=slot.pin();const held=usage();slot.release();slot.release();assert.deepEqual(usage(),held);assert.equal(registration.state.active,1);slot.capture('held pending action');releaseA();releaseA();assert.deepEqual(usage(),held);assert.equal(registration.state.active,1);releaseB();assert.equal(registration.state.active,0);assert.equal(registration.state.releases,1);assert.deepEqual(usage(),before);
});

test('a fully released input cannot retain new text or reopen its accounting authority',()=>{
 const before=usage(),{slot}=input('last');slot.release();for(const mutate of [()=>slot.admit(5),()=>slot.capture('later'),()=>slot.saved('later'),()=>slot.limit(100),()=>slot.pin(),()=>slot.value])assert.throws(mutate,/REQUEST_PROMPT_RELEASED/);assert.deepEqual(usage(),before);
});

test('Entry registration survives all pre-existing render and asynchronous payload pins',()=>{
 const before=usage(),r=registry(),value={id:'entry',text:'exact'},model=createOwnedModel('prompt-entry-test',modelPayloadBytes(value),()=>value,'prompt'),entry=registerRequestEntry(model,()=>r.register()),releaseA=entry.pin(),releaseB=entry.pin();entry.release();entry.release();assert.equal(r.state.active,1);assert.equal(entry.value.text,'exact');releaseA();assert.equal(r.state.active,1);releaseB();releaseB();assert.deepEqual(r.state,{calls:1,active:0,releases:1});assert.throws(()=>entry.pin(),/REQUEST_ENTRY_REGISTRATION_RELEASED/);assert.throws(()=>model.pin(),/MODEL_MEMORY_RELEASED/);assert.deepEqual(usage(),before);
});

test('failed Entry registration leaves the supplied payload under its original caller owner',()=>{
 const before=usage(),value={text:'caller-owned'},model=createOwnedModel('prompt-entry-register-refusal',modelPayloadBytes(value),()=>value,'prompt');try{const live=usage();assert.throws(()=>registerRequestEntry(model,()=>{throw Error('REGISTER_REFUSED');}),/REGISTER_REFUSED/);assert.deepEqual(usage(),live);const release=model.pin();release();assert.equal(model.value.text,'caller-owned');}finally{model.release();}assert.deepEqual(usage(),before);
});

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const native=value=>({value,isConnected:true,updateComplete:Promise.resolve()});
async function retire(slot,node){node.isConnected=false;await slot.retireNative(()=>false);slot.release();}

test('already accepted native overage exceeds the real prompt peak without granting normal admission or double charging a retry',async()=>{
 const before=usage(),{slot}=input('saved'),node=native('x'.repeat(REQUEST_PROMPT_HEADROOM+1024)+'東京😀');let block;
 try{block=pressure();const full=usage();slot.observeNative(node,node.value);slot.nativeOverflow=true;slot.refused=true;const debt=usage(),expected=(node.value.length-REQUEST_PROMPT_HEADROOM)*8;assert.equal(debt.promptBytes,full.promptBytes+expected);assert(debt.promptBytes>ALLOCATION_LIMITS.promptBytes);assert.equal(debt.cpuBytes,full.cpuBytes+expected);assert(allocationLedger.snapshot().promptPeakBytes>=debt.promptBytes);assert(allocationLedger.snapshot().peaks.cpuBytes>=debt.cpuBytes);assert.equal(debt.activeRecords,full.activeRecords,'Observation uses its pre-admitted record');assert.equal(debt.handles,full.handles);assert.throws(()=>slot.admit(node.value.length),/PROMPT_MEMORY_BUDGET/);assert.equal(slot.value,'saved');assert.equal(slot.retryValue(),node.value);assert.deepEqual(usage(),debt);block.release();block=null;slot.admit(node.value.length);assert.equal(usage().promptBytes-before.promptBytes,slot.capacity*8+1024,'The effective owner is max(admitted, observed), never their sum');slot.saved(slot.retryValue());assert.equal(slot.value,node.value);assert.equal(slot.refused,false);}finally{block?.release();await retire(slot,node);}assert.deepEqual(usage(),before);
});

test('shorter actual input refunds overage only after parent render, control render, and every old action pin',async()=>{
 const before=usage(),{slot}=input('saved'),node=native('x'.repeat(REQUEST_PROMPT_HEADROOM+500)),parent=deferred(),control=deferred(),release=slot.pin();let task;
 try{slot.observeNative(node,node.value);const charged=usage();node.value='short';node.updateComplete=control.promise;slot.observeNative(node,node.value);task=slot.settleNative(()=>parent.promise,()=>true);await flush();assert.deepEqual(usage(),charged);parent.resolve();await flush();assert.deepEqual(usage(),charged);control.resolve();await flush();assert.deepEqual(usage(),charged,'A completed render cannot retire the pinned older value');release();await task;assert.equal(usage().promptBytes-before.promptBytes,REQUEST_PROMPT_HEADROOM*8+1024);}finally{parent.resolve();control.resolve();release();await task;await retire(slot,node);}assert.deepEqual(usage(),before);
});

test('an older settlement never refunds a newer native generation or a stale IME detail value',async()=>{
 const before=usage(),{slot}=input('saved'),node=native('old'),render=deferred();let task;
 try{const first='x'.repeat(REQUEST_PROMPT_HEADROOM+400);slot.observeNative(node,first);slot.nativeOverflow=true;slot.refused=true;task=slot.settleNative(()=>render.promise,()=>true);const next=first+'東京😀';slot.observeNative(node,next);const charged=usage();render.resolve();await task;assert.deepEqual(usage(),charged);assert.throws(()=>slot.retryValue(),/still settling/);await slot.settleNative(()=>Promise.resolve(),()=>true);assert.deepEqual(usage(),charged,'Stale public native value does not retire the full retained IME detail');node.value=next;assert.equal(slot.retryValue(),next);slot.admit(next.length);slot.saved(next);await slot.settleNative(()=>Promise.resolve(),()=>true);assert.equal(slot.value,next);}finally{render.resolve();await task;await retire(slot,node);}assert.deepEqual(usage(),before);
});

test('observed event data stays charged through task completion while prospective insertion length is never called observed',async t=>{
 const before=usage(),{slot}=input('saved'),node=native('saved');let task;
 t.mock.timers.enable({apis:['setTimeout']});try{slot.observeNative(node,node.value);const actual='x'.repeat(REQUEST_PROMPT_HEADROOM+700);slot.observeEventData(actual);const charged=usage();assert.equal(slot.observedCPUBytes,actual.length*8+1024);assert.throws(()=>slot.admit(slot.maximum+1),/REQUEST_PROMPT_LIMIT/);assert.deepEqual(usage(),charged,'A predicted larger insertion is refused, not registered as native data');task=slot.settleNative(()=>Promise.resolve(),()=>true);await flush();assert.deepEqual(usage(),charged);t.mock.timers.tick(0);await task;assert.equal(usage().promptBytes-before.promptBytes,REQUEST_PROMPT_HEADROOM*8+1024);}finally{t.mock.timers.tick(0);await task;t.mock.timers.reset();await retire(slot,node);}assert.deepEqual(usage(),before);
});

test('failed control retirement keeps registration and debt; detached app ownership still waits for captured actions',async()=>{
 const before=usage(),{slot,registration}=input('saved'),node=native('x'.repeat(REQUEST_PROMPT_HEADROOM+900)),release=slot.pin();
 try{slot.observeNative(node,node.value);const charged=usage();node.updateComplete=Promise.reject(Error('control render refused'));void node.updateComplete.catch(()=>{});await assert.rejects(slot.retireNative(()=>false),/control render refused/);assert.throws(()=>slot.release(),/NATIVE_RETAINED/);assert.deepEqual(usage(),charged);assert.equal(registration.state.active,1);node.updateComplete=Promise.resolve();await assert.rejects(slot.retireNative(()=>false),/NATIVE_RETAINED/);node.isConnected=false;await slot.retireNative(()=>false);assert(node.value.length>REQUEST_PROMPT_HEADROOM,'Detached app retirement does not claim opaque native buffer clear');slot.release();assert.deepEqual(usage(),charged,'Removing the control does not retire captured action ownership');assert.equal(slot.value,'saved');release();assert.equal(registration.state.active,0);}finally{node.updateComplete=Promise.resolve();node.isConnected=false;await slot.retireNative(()=>false).catch(()=>{});slot.release();release();}assert.deepEqual(usage(),before);
});

test('node identity and a generation change during native retirement both refuse to move ownership',async()=>{
 const before=usage(),{slot}=input('saved'),node=native('actual'),other=native('unrelated'),control=deferred();let task;
 try{slot.observeNative(node,node.value);assert.throws(()=>slot.observeNative(other,other.value),/NATIVE_CHANGED/);node.updateComplete=control.promise;node.isConnected=false;task=slot.retireNative(()=>false);slot.observeNative(node,'newer actual');control.resolve();await assert.rejects(task,/NATIVE_CHANGED/);assert.equal(node.value,'actual','Stale cleanup cannot clear a newer generation');assert.throws(()=>slot.release(),/NATIVE_RETAINED/);}finally{control.resolve();await task?.catch(()=>{});await retire(slot,node);}assert.deepEqual(usage(),before);
});

test('a synchronous parent render failure retains debt and a later settlement really retries',async()=>{
 const before=usage(),{slot}=input('saved'),node=native('x'.repeat(REQUEST_PROMPT_HEADROOM+600));
 try{slot.observeNative(node,node.value);const charged=usage();node.value='short';slot.observeNative(node,node.value);await assert.rejects(slot.settleNative(()=>{throw Error('synchronous render failure');},()=>true),/synchronous render failure/);assert.equal(slot.settlementFailed,true);assert.deepEqual(usage(),charged);let renders=0;await slot.settleNative(()=>{renders++;return Promise.resolve();},()=>true);assert.equal(renders,1,'The rejected previous task cannot latch the settlement slot');assert.equal(slot.settlementFailed,false);assert.equal(usage().promptBytes-before.promptBytes,REQUEST_PROMPT_HEADROOM*8+1024);}finally{await retire(slot,node);}assert.deepEqual(usage(),before);
});

test('connected successor must admit the old IME floor even when its accepted public value is short',async()=>{
 const before=usage(),{slot:prior}=input('old'),{slot:next}=input('short'),node=native('short'),draft='東京😀'.repeat(18000);let block,priorReleased=false;
 try{prior.observeNative(node,draft);const floor=prior.observedCPUBytes;block=pressure();const charged=usage();await assert.rejects(prior.retireNative(n=>{next.inheritNative(n,floor);return true;}),/PROMPT_MEMORY_BUDGET/);assert.deepEqual(usage(),charged);assert.throws(()=>prior.release(),/NATIVE_RETAINED/);block.release();block=null;await prior.retireNative(n=>{next.inheritNative(n,floor);return true;});prior.release();priorReleased=true;assert(next.capacity*8+1024>=floor);assert.equal(next.observedCPUBytes,floor);await next.settleNative(()=>Promise.resolve(),()=>true);assert.equal(next.observedCPUBytes,floor,'A short accepted public value does not prove the longer composing draft was replaced');next.observeNative(node,'short',false);await next.settleNative(()=>Promise.resolve(),()=>true);assert.equal(next.observedCPUBytes,floor,'Another accepted-only read cannot erase transferred native draft ownership');next.observeNative(node,'short',true);await next.settleNative(()=>Promise.resolve(),()=>true);assert.equal(next.observedCPUBytes,'short'.length*8+1024,'An actual full draft observation establishes replacement after rendering and pins');}finally{block?.release();if(!priorReleased)await retire(prior,node);await retire(next,node);}assert.deepEqual(usage(),before);
});

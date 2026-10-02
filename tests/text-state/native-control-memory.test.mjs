// Source-only authored coverage; no gate has been run for this packet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {allocationsURL,promptMemoryURL} from '../owned-preview-module.mjs';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function module(path,imports={}){let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;for(const [name,url]of Object.entries(imports))code=code.replaceAll(JSON.stringify(name),JSON.stringify(url)).replaceAll("'"+name+"'",JSON.stringify(url));return data(code);}
const models=await module('src/observability/model-memory.ts',{'./allocations.js':allocationsURL,'./prompt-memory.js':promptMemoryURL});
const root=process.env.IE_NATIVE_CONTROL_API_SOURCE_ROOT??process.env.IE_NATIVE_CONTROLS_SOURCE_ROOT??'',memoryURL=await module((root?root+'/':'')+'src/ui/native-control-memory.ts',{'../observability/allocations.js':allocationsURL,'../observability/model-memory.js':models});
const {NativeControlMemory,NATIVE_CONTROL_LIMITS,nativeDiagnostic}=await import(memoryURL),{allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL);
const ledgerBaseline=allocationLedger.snapshot().activeRecords;
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
const owners=new Set(),leases=new Set();
function owner(host={requestUpdate(){this.updateComplete=Promise.resolve();},updateComplete:Promise.resolve()}){const value=new NativeControlMemory(host);owners.add(value);return value;}
const retain=value=>{leases.add(value);return value;};
test.afterEach(async()=>{for(const value of leases)value.release();leases.clear();for(const value of owners){await value.drain();assert.deepEqual(value.inspect(),{models:0,retired:0,failed:0,pending:0,actions:0});}owners.clear();assert.equal(allocationLedger.snapshot().activeRecords,ledgerBaseline);});
test('native model admission refuses before factory or clone can allocate',()=>{
 const memory=owner(),pressure=retain(allocationLedger.reserve({owner:'native-test-pressure',kind:'prompt',cpuBytes:ALLOCATION_LIMITS.promptBytes}));let entered=0;
 assert.throws(()=>memory.create('session',10,()=>{entered++;return 'new';}),/PROMPT_MEMORY_BUDGET/);assert.equal(entered,0);assert.equal(memory.inspect().models,0);pressure.release();
});
test('native model construction failure and underestimated allowance refund only failed proposals',()=>{
 const memory=owner(),prior=retain(memory.create('session',16,()=>({text:'old'})));assert.throws(()=>memory.create('session',0,()=>({text:'too large'})),/NATIVE_CONTROL_ALLOWANCE/);assert.throws(()=>memory.create('session',16,()=>{throw Error('factory');}),/factory/);assert.equal(prior.value.text,'old');assert.equal(memory.inspect().models,1);
});
test('native action pins keep a retired immutable text generation charged until actual final unpin',()=>{
 const memory=owner(),model=retain(memory.create('session',32,()=>({text:'complete'}))),unpin=model.pin();model.release();assert.equal(memory.inspect().models,1);assert.ok(allocationLedger.snapshot().promptBytes>0);unpin();unpin();assert.equal(memory.inspect().models,0);assert.throws(()=>model.pin(),/NATIVE_CONTROL_RELEASED/);
});
test('native render retirement waits for the actual host commit and does not duplicate owners',async()=>{
 const gate=deferred();const host={requestUpdate(){this.updateComplete=gate.promise;},updateComplete:Promise.resolve()},memory=owner(host),model=retain(memory.create('session',32,()=>({text:'complete'})));try{for(let i=0;i<100;i++)memory.retire(model);await flush();let done=false;const drain=memory.drain().then(()=>{done=true;});await flush();assert.equal(done,false);assert.equal(memory.inspect().retired,1);assert.equal(memory.inspect().pending,1);assert.ok(allocationLedger.snapshot().promptBytes>0);gate.resolve();await drain;}finally{gate.resolve();}
});
test('failed native host commit retains the actual model until a confirmed retry',async()=>{
 let fail=true;const host={requestUpdate(){this.updateComplete=fail?Promise.reject(Error('render failed')):Promise.resolve();},updateComplete:Promise.resolve()},memory=owner(host),model=retain(memory.create('session',32,()=>({text:'complete'})));
 try{memory.retire(model);await flush();await assert.rejects(memory.drain(),/NATIVE_CONTROL_RENDER_RELEASE/);assert.equal(memory.inspect().failed,1);assert.equal(memory.inspect().models,1);}finally{fail=false;await memory.drain();}
});
test('native model and action count caps refuse without dropping any existing owner',()=>{
 const memory=owner();for(let i=0;i<NATIVE_CONTROL_LIMITS.models;i++)retain(memory.create('session',0,()=>null));let entered=0;assert.throws(()=>memory.create('session',0,()=>{entered++;return null;}),/NATIVE_CONTROL_MODELS/);assert.equal(entered,0);
 const actions=[];try{for(let i=0;i<NATIVE_CONTROL_LIMITS.actions;i++)actions.push(memory.action());assert.throws(()=>memory.action(),/NATIVE_CONTROL_ACTIONS/);assert.equal(memory.inspect().actions,NATIVE_CONTROL_LIMITS.actions);}finally{for(const release of actions)release();}
});
test('native diagnostics never stringify arbitrary objects or retain oversized messages',()=>{
 let stringify=0;assert.equal(nativeDiagnostic({toString(){stringify++;throw Error('unsafe');}}),'Text operation unavailable.');assert.equal(stringify,0);assert.equal(nativeDiagnostic(Error('short failure')),'short failure');assert.match(nativeDiagnostic('x'.repeat(NATIVE_CONTROL_LIMITS.diagnosticUnits+1)),/oversized diagnostic/);
});

test('native request handle admission precedes construction and stays owned through a borrowed consumer',()=>{
 const memory=owner(),before=allocationLedger.snapshot(),pressure=retain(allocationLedger.reserve({owner:'native-handle-pressure',kind:'control',handles:ALLOCATION_LIMITS.handles-before.handles-2}));let entered=0;
 assert.throws(()=>memory.create('request',0,()=>{entered++;return null;},()=>0,3),/ALLOCATION_BUDGET/);assert.equal(entered,0);assert.equal(memory.inspect().models,0);pressure.release();
 const request=retain(memory.create('request',0,()=>{entered++;return null;},()=>0,3)),unpin=request.pin();try{assert.equal(allocationLedger.snapshot().handles-before.handles,3);request.release();assert.equal(allocationLedger.snapshot().handles-before.handles,3);unpin();assert.equal(allocationLedger.snapshot().handles,before.handles);}finally{unpin();}
});

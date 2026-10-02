import {allocationDeltaSnapshot} from '../owned-preview-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {allocationsURL,modelMemoryURL,exportMemoryURL} from './memory-module.mjs';
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL),{modelPayloadBytes}=await import(modelMemoryURL),{ExportMemory,EXPORT_MEMORY_LIMITS,exportDiagnostic}=await import(exportMemoryURL);
// Only assertions subtract the fixed import-time diagnostic owner baseline.
// Admission always sees the real total ledger, including those owners.
const snapshot=allocationDeltaSnapshot(allocationLedger);
const owners=new Set(),leases=new Set();
function owner(host={requestUpdate(){this.updateComplete=Promise.resolve(true);},updateComplete:Promise.resolve(true)}){const memory=new ExportMemory(host);owners.add(memory);return memory;}
function tracked(value){leases.add(value);return value;}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const flush=async()=>{for(let index=0;index<12;index++)await Promise.resolve();};
test.afterEach(async()=>{for(const lease of leases)lease.release();leases.clear();for(const memory of owners){await memory.drain();assert.deepEqual(memory.inspect(),{models:0,records:{operation:0,owner:0,action:0},retired:0,pending:0,failed:0});}owners.clear();assert.equal(snapshot().activeRecords,0);});
test('prospective shared-budget refusal never invokes a model factory',()=>{
 const memory=owner(),pressure=tracked(allocationLedger.reserve({owner:'export-fixture-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-allocationLedger.snapshot().cpuBytes}));let calls=0;assert.throws(()=>memory.create('form',64,()=>{calls++;return {value:'new'};}),/ALLOCATION_BUDGET/);assert.equal(calls,0);assert.equal(memory.inspect().models,0);pressure.release();
});
test('a model limit refuses before structuredClone and preserves the previous owned value',()=>{
 const memory=owner(),first=tracked(memory.clone('form',{value:'complete'})),source={value:'x'.repeat(EXPORT_MEMORY_LIMITS.formBytes)},native=globalThis.structuredClone;let copies=0;globalThis.structuredClone=(...args)=>{copies++;return native(...args);};
 try{assert.throws(()=>memory.clone('form',source,EXPORT_MEMORY_LIMITS.formBytes),/EXPORT_MODEL_LIMIT/);assert.equal(copies,0);assert.deepEqual(first.value,{value:'complete'});assert.equal(memory.inspect().models,1);}finally{globalThis.structuredClone=native;}
});
test('failed or underdeclared construction rolls back its admitted payload',()=>{
 const memory=owner();assert.throws(()=>memory.create('form',128,()=>{throw Error('factory failed');}),/factory failed/);assert.throws(()=>memory.create('form',1,()=>({value:'too large'})),/EXPORT_MODEL_ALLOWANCE/);assert.equal(memory.inspect().models,0);assert.equal(snapshot().activeRecords,0);
});
test('pinning retains the actual snapshot and its booking after its resident owner is released',()=>{
 const memory=owner(),model=tracked(memory.clone('document',{id:'original',nested:{name:'retained'}})),expected=modelPayloadBytes(model.value),unpin=model.pin();model.release();assert.equal(memory.inspect().models,1);assert.equal(snapshot().cpuBytes,expected);assert.equal(model.value.nested.name,'retained');unpin();unpin();assert.equal(memory.inspect().models,0);assert.equal(snapshot().activeRecords,0);assert.throws(()=>model.pin(),/EXPORT_MODEL_RELEASED/);
});
for(const kind of ['operation','owner','action'])test(kind+' metadata refuses the next record at its explicit cap without replacing existing owners',()=>{
 const memory=owner(),cap=EXPORT_MEMORY_LIMITS[kind==='operation'?'operations':kind==='owner'?'owners':'actions'];for(let index=0;index<cap;index++)tracked(memory.record(kind));const before=snapshot().cpuBytes;
 assert.throws(()=>memory.record(kind),new RegExp('EXPORT_'+kind.toUpperCase()+'_CAPACITY'));assert.equal(memory.inspect().records[kind],cap);assert.equal(snapshot().cpuBytes,before);
});
test('retired models remain reachable and charged until the actual host commit settles',async()=>{
 const commit=deferred(),host={requestUpdate(){this.updateComplete=commit.promise;},updateComplete:Promise.resolve()},memory=owner(host),model=tracked(memory.clone('document',{name:'previous'}));memory.retire(model);await flush();let drained=false;const drain=memory.drain().then(()=>{drained=true;});await flush();assert.equal(drained,false);assert.equal(memory.inspect().models,1);assert.equal(memory.inspect().retired,1);assert.ok(snapshot().cpuBytes>0);assert.equal(model.value.name,'previous');commit.resolve(true);await drain;assert.equal(memory.inspect().models,0);assert.equal(memory.inspect().retired,0);
});
test('failed UI commit retains actual payload ownership until a subsequent successful commit',async()=>{
 let fail=true;const host={requestUpdate(){this.updateComplete=fail?Promise.reject(Error('render failed')):Promise.resolve(true);},updateComplete:Promise.resolve(true)},memory=owner(host),model=tracked(memory.clone('document',{name:'unreleased old template'}));
 try{memory.retire(model);await flush();await assert.rejects(memory.drain(),/EXPORT_RENDER_RELEASE_UNCONFIRMED/);assert.equal(memory.inspect().models,1);assert.equal(memory.inspect().failed,1);assert.equal(memory.inspect().retired,1);assert.ok(snapshot().cpuBytes>0);assert.equal(model.value.name,'unreleased old template');}
 finally{fail=false;await memory.drain();}assert.equal(memory.inspect().models,0);assert.equal(memory.inspect().failed,0);assert.equal(snapshot().activeRecords,0);
});
test('repeated retirement does not create extra unbounded pending or failure records',async()=>{
 const commit=deferred(),host={requestUpdate(){this.updateComplete=commit.promise;},updateComplete:Promise.resolve()},memory=owner(host),model=tracked(memory.clone('options',{format:'png'}));for(let index=0;index<1000;index++)memory.retire(model);await flush();assert.equal(memory.inspect().retired,1);assert.equal(memory.inspect().pending,1);commit.resolve(true);await memory.drain();assert.equal(memory.inspect().models,0);
});
test('diagnostic overflow is reported explicitly without retaining a truncated arbitrary error payload',()=>{
 assert.equal(exportDiagnostic(Error('exact receipt code')),'exact receipt code');assert.equal(exportDiagnostic(Error('x'.repeat(EXPORT_MEMORY_LIMITS.errorUnits+1))),'Export returned an oversized diagnostic. Inspect its retained command receipt for details.');
});
test('the model count cap rejects before creating a new snapshot',()=>{
 const memory=owner();for(let index=0;index<EXPORT_MEMORY_LIMITS.models;index++)tracked(memory.create('form',0,()=>null));let calls=0;assert.throws(()=>memory.create('form',0,()=>{calls++;return null;}),/EXPORT_MODEL_CAPACITY/);assert.equal(calls,0);assert.equal(memory.inspect().models,EXPORT_MEMORY_LIMITS.models);
});

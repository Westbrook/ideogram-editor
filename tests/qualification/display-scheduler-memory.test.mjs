import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {isolatedDiagnosticModules,allocationDeltaSnapshot} from '../owned-preview-module.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
let serial=0;
async function fixture(){
 const {allocationsURL}=await isolatedDiagnosticModules(),{allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL);
 const path=(process.env.IE_DISPLAY_SOURCE_ROOT?process.env.IE_DISPLAY_SOURCE_ROOT.replace(/\/$/,'')+'/':'')+'src/observability/display-scheduler.ts';
 let code=(await transformWithOxc(await readFile(path,'utf8'),path)).code;
 code=code.replaceAll(JSON.stringify('./allocations.js'),JSON.stringify(allocationsURL)).replaceAll("'./allocations.js'",JSON.stringify(allocationsURL));
 const scheduler=await import('data:text/javascript;base64,'+Buffer.from(code+'\n// scheduler fixture '+ ++serial).toString('base64'));
 return {...scheduler,ledger:allocationLedger,limits:ALLOCATION_LIMITS,snapshot:allocationDeltaSnapshot(allocationLedger)};
}
const settled=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
const occupy=(f,remaining=0)=>f.ledger.reserve({owner:'test-pressure',kind:'scratch',cpuBytes:f.limits.cpuBytes-f.limits.textPartitionBytes-f.ledger.snapshot().cpuBytes-remaining});

test('display queue admission refuses before retaining or invoking work',async()=>{
 const f=await fixture(),pressure=occupy(f);let calls=0;
 try{await assert.rejects(f.withDisplayRead(undefined,async()=>{calls++;}),/ALLOCATION_BUDGET/);assert.equal(calls,0);assert.equal(f.displayReadOwnership().active,0);assert.equal(f.displayReadOwnership().queued,0);}
 finally{pressure.release();}assert.equal(f.snapshot().activeRecords,0);
});

test('queued and active work remain owned through actual completion with FIFO dispatch',async()=>{
 const f=await fixture(),gates=[deferred(),deferred(),deferred()],starts=[];
 const jobs=gates.map((gate,index)=>f.withDisplayRead(undefined,async()=>{starts.push(index);return gate.promise;}));
 await settled();assert.deepEqual(starts,[0,1]);assert.equal(f.displayReadOwnership().queued,1);assert.equal(f.snapshot().activeRecords,3);assert(f.snapshot().cpuBytes>0);assert(f.snapshot().handles>0);
 gates[0].resolve('first');assert.equal(await jobs[0],'first');await settled();assert.deepEqual(starts,[0,1,2]);assert.equal(f.snapshot().activeRecords,2);
 gates[1].resolve('second');gates[2].resolve('third');assert.deepEqual(await Promise.all(jobs),['first','second','third']);assert.equal(f.snapshot().activeRecords,0);
});

test('queued cancellation drops only its own slot and never invokes cancelled work',async()=>{
 const f=await fixture(),a=deferred(),b=deferred(),abort=new AbortController();let called=false;
 const jobs=[f.withDisplayRead(undefined,()=>a.promise),f.withDisplayRead(undefined,()=>b.promise)];
 const queued=f.withDisplayRead(abort.signal,async()=>{called=true;});const rejection=assert.rejects(queued,{name:'AbortError'});
 abort.abort();await rejection;assert.equal(called,false);assert.equal(f.snapshot().activeRecords,2);assert.equal(f.displayReadOwnership().queued,0);
 a.resolve();b.resolve();await Promise.all(jobs);assert.equal(f.snapshot().activeRecords,0);
});

test('aborting active work does not refund its slot before its real cleanup settles',async()=>{
 const f=await fixture(),gate=deferred(),abort=new AbortController();const job=f.withDisplayRead(abort.signal,()=>gate.promise);
 await settled();abort.abort();assert.equal(f.displayReadOwnership().active,1);assert.equal(f.snapshot().activeRecords,1);
 gate.resolve('cleaned');assert.equal(await job,'cleaned');assert.equal(f.snapshot().activeRecords,0);
});

test('the finite queue refuses overflow without extra ownership or truncating admitted work',async()=>{
 const f=await fixture(),gate=deferred(),jobs=[];let starts=0;
 for(let i=0;i<258;i++)jobs.push(f.withDisplayRead(undefined,async()=>{starts++;return gate.promise;}));
 await settled();assert.equal(starts,2);assert.equal(f.displayReadOwnership().queued,256);const before=f.snapshot();
 await assert.rejects(f.withDisplayRead(undefined,async()=>{throw Error('overflow ran');}),/DISPLAY_QUEUE_CAPACITY/);assert.equal(f.snapshot().activeRecords,before.activeRecords);
 gate.resolve();await Promise.all(jobs);assert.equal(starts,258);assert.equal(f.snapshot().activeRecords,0);
});

test('drain callers share one admitted notification until all work actually settles',async()=>{
 const f=await fixture(),gate=deferred(),job=f.withDisplayRead(undefined,()=>gate.promise),before=f.snapshot(),drain=f.waitForDisplayReads();
 for(let i=0;i<1000;i++)assert.equal(f.waitForDisplayReads(),drain);
 assert.equal(f.snapshot().activeRecords,before.activeRecords+1);let done=false;void drain.then(()=>{done=true;});await settled();assert.equal(done,false);
 gate.resolve();await Promise.all([job,drain]);assert.equal(done,true);assert.equal(f.snapshot().activeRecords,0);
});

test('a failed drain admission leaves the active job owned and can be retried',async()=>{
 const f=await fixture(),gate=deferred(),job=f.withDisplayRead(undefined,()=>gate.promise),pressure=occupy(f);
 try{await assert.rejects(f.waitForDisplayReads(),/ALLOCATION_BUDGET/);assert.equal(f.displayReadOwnership().active,1);}
 finally{pressure.release();}
 const drain=f.waitForDisplayReads();gate.resolve();await Promise.all([job,drain]);assert.equal(f.snapshot().activeRecords,0);
});

test('work failure preserves the actual rejection and still releases queued drain ownership',async()=>{
 const f=await fixture(),gate=deferred(),job=f.withDisplayRead(undefined,()=>gate.promise),drain=f.waitForDisplayReads();
 const observed=job.then(()=>assert.fail('failed work passed'),reason=>assert.equal(reason,null));gate.reject(null);await Promise.all([observed,drain]);assert.equal(f.snapshot().activeRecords,0);assert.equal(f.displayReadOwnership().active,0);
});

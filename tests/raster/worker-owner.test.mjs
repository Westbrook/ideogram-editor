import {diagnosticMemoryURL,allocationsURL} from '../owned-preview-module.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';

// Unit protocol doubles below are not runtime/performance restart evidence.
const base=new URL('../../',import.meta.url),data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
async function module(path,replace={}){let code=(await transformWithOxc(await readFile(new URL(path,base),'utf8'),path)).code;for(const [name,value]of Object.entries(replace))code=code.replaceAll(JSON.stringify(name),JSON.stringify(value)).replaceAll("'"+name+"'",JSON.stringify(value));return data(code);}
const protocol=await module('server/raster/worker-protocol.ts');
const errors=data('export class StoreError extends Error { constructor(code){super(code);this.code=code;} }');
const serverDiagnostic=await module('server/observability/diagnostic-memory.ts',{'../../src/observability/diagnostic-memory.js':diagnosticMemoryURL});
const adapterResourcesURL=await module('server/observability/adapter-resources.ts');
const {allocationLedger}=await import(allocationsURL);
const {RASTER_DIAGNOSTIC_BYTES}=await import(serverDiagnostic);
const {RasterWorkerOwner}=await import(await module('server/raster/worker-owner.ts',{'./worker-protocol.js':protocol,'../storage/errors.js':errors,'../../src/observability/diagnostic-memory.js':diagnosticMemoryURL,'../observability/diagnostic-memory.js':serverDiagnostic,'../observability/adapter-resources.js':adapterResourcesURL}));
let nextThread=1;
class Port extends EventEmitter {
 constructor(generation,{autoReady=true}={}){super();this.generation=generation;this.threadId=nextThread++;this.sent=[];this.terminated=0;if(autoReady)queueMicrotask(()=>this.ready());}
 ready(){this.emit('message',{type:'ready',protocolVersion:1,generation:this.generation,threadId:this.threadId,startedMs:1,clockOriginUnixMs:2});}
 postMessage(value){this.sent.push(value);}
 async terminate(){this.terminated++;this.emit('exit',1);return 1;}
 reply(type,extra={}){const job=this.sent.findLast(value=>value.type==='run');this.emit('message',{type,generation:this.generation,jobId:job?.jobId,...extra});}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const fixture=(options={})=>{
 const ports=[],observed=[];
 return {
  ports,observed,
  owner:new RasterWorkerOwner(generation=>{const port=new Port(generation,options);ports.push(port);return port;}),
  hooks:{
   check(){},
   admit(plan){observed.push(['admit',plan]);},
   telemetry(read){observed.push(['telemetry',read.value.schemaVersion]);},
   failure(message){return Object.assign(Error(message.code),{code:message.code});},
  },
 };
};
const job={type:'compose',directory:'/owned/job',width:1,height:1,layers:[],inputs:[],dependencies:[]};
const plan={cpuBytes:1,diskBytes:1},result={metrics:{},plan},telemetry={schemaVersion:1};
async function run(f,slot='history:a'){const work=f.owner.run(job,slot,f.hooks);work.catch(()=>{});await tick();const port=f.ports.at(-1);port.reply('plan',{plan});port.reply('result',{result,telemetry});return {work,port};}

test('real jobs share one idle service but each has fresh admission and job identity',async()=>{
 const f=fixture();try{
  const first=await run(f);let settled=false;first.work.then(()=>settled=true);await tick();assert.equal(settled,false,'Result cannot resolve before cleanup/idle acknowledgement');first.port.reply('idle',{completed:true,retainedJobReferences:0});await first.work;
  const identity=f.owner.snapshot.identity;assert.equal(f.owner.snapshot.activeJobs,0);assert.equal(f.owner.snapshot.retainedJobReferences,0);assert.equal(f.owner.snapshot.idleWorkers,1);
  const second=await run(f,'display:b');assert.equal(first.port,second.port);assert.notEqual(first.port.sent[0].jobId,first.port.sent.findLast(row=>row.type==='run').jobId);
  second.port.reply('idle',{completed:true,retainedJobReferences:0});await second.work;assert.deepEqual(f.owner.snapshot.identity,identity);assert.equal(f.observed.filter(row=>row[0]==='admit').length,2);
 }finally{await f.owner.close();}
});
test('idle restart awaits the actual prior exit and creates a new native thread generation without a dummy job',async()=>{
 const f=fixture();try{const a=await run(f);a.port.reply('idle',{completed:true,retainedJobReferences:0});await a.work;
  const receipt=await f.owner.restartIdle(f.owner.snapshot.generation);assert.equal(a.port.terminated,1);assert.notEqual(receipt.before.threadId,receipt.after.threadId);assert.equal(receipt.after.generation,receipt.before.generation+1);assert(receipt.terminatedMs>=receipt.startedMs);assert(receipt.readyMs>=receipt.terminatedMs);assert.equal(receipt.nativeAllocatorReleaseClaim,false);assert.deepEqual(f.ports[1].sent,[]);
 }finally{await f.owner.close();}
});
test('restart rejects an absent service, a busy job, or a stale generation',async()=>{
 const f=fixture();try{await assert.rejects(f.owner.restartIdle(0),/QUEUE_FULL/);const a=await run(f);await assert.rejects(f.owner.restartIdle(1),/QUEUE_FULL/);a.port.reply('idle',{completed:true,retainedJobReferences:0});await a.work;await assert.rejects(f.owner.restartIdle(0),/STALE_EPOCH/);assert.equal(a.port.terminated,0);}finally{await f.owner.close();}
});
test('a second lane cannot enter while one job is running',async()=>{
 const f=fixture();try{const a=await run(f);await assert.rejects(f.owner.run(job,'display:b',f.hooks),/QUEUE_FULL/);a.port.reply('idle',{completed:true,retainedJobReferences:0});await a.work;}finally{await f.owner.close();}
});
for(const [name,type,extra]of [
 ['result before admission','result',{result}],['idle without result','idle',{completed:true,retainedJobReferences:0}],
 ['stale job ID','plan',{plan,jobId:999}],['wrong generation','plan',{plan,generation:999}],
])test('invalid protocol retires the worker: '+name,async()=>{
 const f=fixture();try{const work=f.owner.run(job,'history:a',f.hooks);work.catch(()=>{});await tick();f.ports[0].reply(type,extra);await assert.rejects(work,/CORRUPT_STORE/);assert.equal(f.ports[0].terminated,1);assert.equal(f.owner.snapshot.workerCount,0);}finally{await f.owner.close();}
});
test('resource/native failure retains exact evidence and poisons reuse until a fresh worker',async()=>{
 const f=fixture();f.hooks.failure=message=>{f.observed.push(['failure',message.resourceFailure]);return Error(message.code);};try{
  const work=f.owner.run(job,'candidate-prepare:a',f.hooks);work.catch(()=>{});await tick();f.ports[0].reply('failure',{code:'RASTER_RESOURCES',resourceFailure:{outputPeak:8192,outputRemaining:4096}});await assert.rejects(work,/RASTER_RESOURCES/);assert.deepEqual(f.observed.find(row=>row[0]==='failure')[1],{outputPeak:8192,outputRemaining:4096});
  const next=await run(f);assert.equal(f.ports.length,2);next.port.reply('idle',{completed:true,retainedJobReferences:0});await next.work;
 }finally{await f.owner.close();}
});
test('native cleanup failure is retained even when document authority has become stale',async()=>{
 const f=fixture();let stale=false;f.hooks.check=()=>{if(stale)throw Error('CLOSED');};f.hooks.failure=message=>{f.observed.push(['failure',message.resourceFailure]);return Error(message.code);};
 try{const work=f.owner.run(job,'queue:source',f.hooks);work.catch(()=>{});await tick();stale=true;f.ports[0].reply('failure',{code:'RASTER_RESOURCES',resourceFailure:{outputPeak:8192,outputRemaining:4096}});await assert.rejects(work,/RASTER_RESOURCES/);assert.deepEqual(f.observed.find(row=>row[0]==='failure')[1],{outputPeak:8192,outputRemaining:4096});}finally{await f.owner.close();}
});
test('cancellation retains matching late native cleanup evidence before awaited exit',async()=>{
 const f=fixture();f.hooks.failure=message=>{f.observed.push(['failure',message.resourceFailure]);return Error(message.code);};
 const work=f.owner.run(job,'display:a',f.hooks);work.catch(()=>{});await tick();const port=f.ports[0];let finish;
 port.terminate=()=>{port.terminated++;return new Promise(resolve=>{finish=()=>{port.emit('exit',1);resolve(1);};});};
 const interrupted=f.owner.interrupt('display:a');let complete=false;interrupted.then(()=>complete=true);await tick();assert.equal(complete,false);
 port.reply('failure',{code:'RASTER_RESOURCES',resourceFailure:{outputPeak:8192,outputRemaining:4096}});assert.deepEqual(f.observed.find(row=>row[0]==='failure')[1],{outputPeak:8192,outputRemaining:4096});finish();await interrupted;await assert.rejects(work,/CLOSED/);assert.equal(port.terminated,1);await f.owner.close();
});
test('cancellation cannot kill a different lane and resolves only after the owned worker exits',async()=>{
 const f=fixture();try{const work=f.owner.run(job,'display:a',f.hooks);work.catch(()=>{});await tick();assert.equal(await f.owner.interrupt('history:a'),false);assert.equal(f.ports[0].terminated,0);assert.equal(await f.owner.interrupt('display:a'),true);await assert.rejects(work,/CLOSED/);assert.equal(f.owner.snapshot.workerCount,0);}finally{await f.owner.close();}
});
test('admission failure terminates the process without sending admit',async()=>{
 const f=fixture();f.hooks.admit=()=>{throw Error('CAPACITY');};try{const work=f.owner.run(job,'history:a',f.hooks);work.catch(()=>{});await tick();f.ports[0].reply('plan',{plan});await assert.rejects(work,/CAPACITY/);assert.equal(f.ports[0].sent.some(row=>row.type==='admit'),false);}finally{await f.owner.close();}
});
test('close drains owned active work and permanently prevents another launch',async()=>{
 const f=fixture(),work=f.owner.run(job,'history:a',f.hooks);work.catch(()=>{});await tick();await f.owner.close();await assert.rejects(work,/CLOSED/);await assert.rejects(f.owner.run(job,'history:b',f.hooks),/CLOSED/);assert.equal(f.owner.snapshot.workerCount,0);
});

test('real central refusal prevents worker construction before any native hooks',async()=>{
 const baseline=allocationLedger.snapshot();let constructed=0;const owner=new RasterWorkerOwner(()=>{constructed++;throw Error('must-not-construct');});
 const blocker=allocationLedger.reserve({owner:'worker-pressure',kind:'control',cpuBytes:384*1024**2-baseline.cpuBytes});
 try{await assert.rejects(owner.run(job,'history:a',fixture().hooks),/ALLOCATION_BUDGET/);assert.equal(constructed,0);}finally{blocker.release();await owner.close();}
 assert.equal(allocationLedger.snapshot().cpuBytes,baseline.cpuBytes);
});
test('worker grant and pending ingress remain held after terminate rejection until actual late exit',async()=>{
 const baseline=allocationLedger.snapshot(),f=fixture(),work=f.owner.run(job,'history:a',f.hooks);work.catch(()=>{});let port;
 try{await tick();port=f.ports[0];port.terminate=async()=>{port.terminated++;throw undefined;};
  await assert.rejects(f.owner.close(),error=>error===undefined);assert.ok(allocationLedger.snapshot().cpuBytes>=baseline.cpuBytes+RASTER_DIAGNOSTIC_BYTES);assert.equal(f.owner.snapshot.workerCount,1);
  port.emit('exit',1);await assert.rejects(work,/CLOSED/);await f.owner.close();assert.equal(allocationLedger.snapshot().cpuBytes,baseline.cpuBytes);assert.equal(allocationLedger.snapshot().handles,baseline.handles);
 }finally{port??=f.ports[0];if(port){port.terminate=async()=>{port.emit('exit',1);return 1;};if(f.owner.snapshot.workerCount)port.emit('exit',1);}await f.owner.close();await work.catch(()=>{});}
});
test('telemetry is borrowed only within its explicit scope and never escapes in ordinary result',async()=>{
 const baseline=allocationLedger.snapshot(),f=fixture();let retained;
 f.hooks.telemetry=read=>{retained=read;assert.equal(read.value.schemaVersion,1);};
 try{const a=await run(f);assert.throws(()=>retained.value,/RELEASED/);a.port.reply('idle',{completed:true,retainedJobReferences:0});const value=await a.work;assert.equal('telemetry'in value,false);assert.equal('activeCompute'in value,false);}finally{await f.owner.close();}
 assert.equal(allocationLedger.snapshot().cpuBytes,baseline.cpuBytes);
});


// Ready-worker capabilities are protocol tests only; they make no native-memory claim.
async function idle(f,slot='history:warm'){
 const attempt=await run(f,slot);attempt.port.reply('idle',{completed:true,retainedJobReferences:0});await attempt.work;return attempt.port;
}
async function rejectReady(f,lease,code='CAPACITY',slot='display:pinned'){
 const before=allocationLedger.snapshot(),ports=f.ports.length,sent=f.ports.map(port=>port.sent.length),observed=f.observed.length;let checks=0;
 await assert.rejects(f.owner.run(job,slot,{...f.hooks,check(){checks++;}},lease),error=>error?.code===code);
 assert.equal(checks,0,'Invalid capabilities must fail before authority hooks');assert.equal(f.ports.length,ports,'Pinned rejection must never construct a worker');
 assert.deepEqual(f.ports.map(port=>port.sent.length),sent,'Pinned rejection must never dispatch');assert.equal(f.observed.length,observed);
 const after=allocationLedger.snapshot();assert.equal(after.cpuBytes,before.cpuBytes,'Rejection must not acquire a diagnostic lease');assert.equal(after.handles,before.handles);
}
function holdTermination(port){
 let finish;
 port.terminate=()=>{port.terminated++;return new Promise(resolve=>{finish=()=>{port.emit('exit',1);resolve(1);};});};
 return ()=>{assert.equal(typeof finish,'function');finish();};
}

test('ready lease is absent for cold, not-ready and busy owners; ordinary cold dispatch is preserved',async()=>{
 const f=fixture({autoReady:false});let work;
 try{
  assert.equal(f.owner.readyIdentity,null);await rejectReady(f,{generation:1,threadId:1,startedMs:1,clockOriginUnixMs:2});assert.equal(f.ports.length,0);
  work=f.owner.run(job,'history:cold',f.hooks);work.catch(()=>{});assert.equal(f.ports.length,1);assert.equal(f.owner.readyIdentity,null);assert.deepEqual(f.ports[0].sent,[]);
  await tick();assert.equal(f.owner.readyIdentity,null);f.ports[0].ready();await tick();assert.equal(f.owner.readyIdentity,null,'Ready but active is not idle');
  f.ports[0].reply('plan',{plan});f.ports[0].reply('result',{result,telemetry});assert.equal(f.owner.readyIdentity,null,'Result still awaits the idle acknowledgement');
  f.ports[0].reply('idle',{completed:true,retainedJobReferences:0});await work;assert.deepEqual(f.owner.readyIdentity,f.owner.snapshot.identity);
 }finally{await f.owner.close();await work?.catch(()=>{});}
});

test('a real frozen ready lease dispatches only on its existing native generation',async()=>{
 const f=fixture();try{
  const port=await idle(f),lease=f.owner.readyIdentity,previousJob=port.sent.findLast(row=>row.type==='run').jobId;
  assert(lease);assert(Object.isFrozen(lease));assert.deepEqual(lease,f.owner.snapshot.identity);
  const work=f.owner.run(job,'display:pinned',f.hooks,lease);work.catch(()=>{});assert.equal(f.owner.readyIdentity,null);await tick();
  assert.equal(f.ports.length,1);assert.equal(f.ports[0],port);assert.equal(port.terminated,0);assert(port.sent.findLast(row=>row.type==='run').jobId>previousJob);
  port.reply('plan',{plan});port.reply('result',{result,telemetry});port.reply('idle',{completed:true,retainedJobReferences:0});assert.equal(await work,result);
  await rejectReady(f,lease);assert.equal(f.owner.snapshot.idleWorkers,1);
 }finally{await f.owner.close();}
});

for(const [name,copy]of [
 ['copied identity',lease=>({...lease})],['frozen copy',lease=>Object.freeze({...lease})],
 ['forged generation',lease=>({...lease,generation:lease.generation+1})],['forged thread',lease=>({...lease,threadId:lease.threadId+1})],
 ['forged startup time',lease=>({...lease,startedMs:lease.startedMs+1})],['forged clock origin',lease=>({...lease,clockOriginUnixMs:lease.clockOriginUnixMs+1})],
])test('ready lease rejects '+name+' before acquiring ownership',async()=>{
 const f=fixture();try{await idle(f);await rejectReady(f,copy(f.owner.readyIdentity));assert.equal(f.owner.snapshot.idleWorkers,1);}finally{await f.owner.close();}
});

test('a snapshot and another owner\'s genuine lease cannot authorize ready dispatch',async()=>{
 const f=fixture(),other=fixture();try{
  await idle(f);await idle(other);await rejectReady(f,f.owner.snapshot.identity);const foreign=other.owner.readyIdentity;await rejectReady(f,foreign);
  const work=other.owner.run(job,'display:issuer',other.hooks,foreign);work.catch(()=>{});await tick();const port=other.ports[0];
  port.reply('plan',{plan});port.reply('result',{result,telemetry});port.reply('idle',{completed:true,retainedJobReferences:0});await work;
  assert.equal(other.ports.length,1,'A foreign refusal must not consume the issuer\'s capability');
 }finally{await f.owner.close();await other.owner.close();}
});

test('ready capability is consumed even when a later slot gate rejects',async()=>{
 const f=fixture();try{await idle(f);const lease=f.owner.readyIdentity;await rejectReady(f,lease,'MALFORMED_REQUEST','invalid');await rejectReady(f,lease);assert.equal(f.owner.snapshot.idleWorkers,1);}finally{await f.owner.close();}
});

test('an intervening completed job invalidates an unused lease on the same worker',async()=>{
 const f=fixture();try{
  const port=await idle(f),lease=f.owner.readyIdentity;await idle(f,'history:intervening');assert.equal(f.ports[0],port);assert.deepEqual(f.owner.snapshot.identity,lease);
  await rejectReady(f,lease);const work=f.owner.run(job,'display:fresh',f.hooks,f.owner.readyIdentity);work.catch(()=>{});await tick();
  port.reply('plan',{plan});port.reply('result',{result,telemetry});port.reply('idle',{completed:true,retainedJobReferences:0});await work;assert.equal(f.ports.length,1);
 }finally{await f.owner.close();}
});

test('actual idle exit removes readiness and a lost-generation lease cannot cold-spawn',async()=>{
 const f=fixture();try{const port=await idle(f),lease=f.owner.readyIdentity;port.emit('exit',1);assert.equal(f.owner.readyIdentity,null);assert.equal(f.owner.snapshot.workerCount,0);await rejectReady(f,lease);assert.equal(f.ports.length,1);}finally{await f.owner.close();}
});

test('idle native termination hides readiness before actual exit and cannot authorize a pinned run',async()=>{
 const f=fixture();let finish;
 try{const port=await idle(f),lease=f.owner.readyIdentity;finish=holdTermination(port);port.emit('error',Error('native failure'));assert.equal(port.terminated,1);
  assert.equal(f.owner.snapshot.closed,false);assert.equal(f.owner.snapshot.restarting,false);assert.equal(f.owner.snapshot.activeJobs,0);assert.equal(f.owner.readyIdentity,null);
  await rejectReady(f,lease);finish();finish=undefined;await tick();assert.equal(f.owner.readyIdentity,null);assert.equal(f.ports.length,1);
 }finally{finish?.();await f.owner.close();}
});

test('restart suppresses leases until its actual replacement is ready and invalidates old leases',async()=>{
 const f=fixture();let finish,restart;
 try{
  const port=await idle(f),busyLease=f.owner.readyIdentity,oldLease=f.owner.readyIdentity;finish=holdTermination(port);
  restart=f.owner.restartIdle(f.owner.snapshot.generation);restart.catch(()=>{});assert.equal(f.owner.readyIdentity,null);assert.equal(f.owner.snapshot.restarting,true);
  await rejectReady(f,busyLease,'QUEUE_FULL');finish();finish=undefined;const receipt=await restart;
  assert.equal(f.ports.length,2);assert.deepEqual(f.owner.readyIdentity,receipt.after);await rejectReady(f,oldLease);assert.equal(f.ports[1].sent.length,0);
 }finally{finish?.();await restart?.catch(()=>{});await f.owner.close();}
});

test('close suppresses leases while termination is pending and permanently rejects old leases',async()=>{
 const f=fixture();let finish,closing;
 try{const port=await idle(f),lease=f.owner.readyIdentity;finish=holdTermination(port);closing=f.owner.close();closing.catch(()=>{});
  assert.equal(f.owner.readyIdentity,null);await rejectReady(f,lease,'CLOSED');assert.equal(f.ports.length,1);finish();finish=undefined;await closing;assert.equal(f.owner.readyIdentity,null);
 }finally{finish?.();await closing?.catch(()=>{});await f.owner.close();}
});

for(const [name,at,loss]of [
 ['exit in the first authority hook','first','exit'],['exit in the post-readiness authority hook','second','exit'],['exit in the readiness microtask gap','microtask','exit'],
 ['close in the first authority hook','first','close'],['close in the post-readiness authority hook','second','close'],['close in the readiness microtask gap','microtask','close'],
])test('pinned dispatch fails closed after '+name,async()=>{
 const f=fixture();let closing;
 try{
  const port=await idle(f),lease=f.owner.readyIdentity,sent=port.sent.length;let checks=0;
  const invalidate=()=>{if(loss==='exit')port.emit('exit',1);else{closing=f.owner.close();closing.catch(()=>{});}};
  const hooks={...f.hooks,check(){checks++;if(at==='first'&&checks===1||at==='second'&&checks===2)invalidate();else if(at==='microtask'&&checks===1)queueMicrotask(invalidate);}};
  const work=f.owner.run(job,'display:lost',hooks,lease);work.catch(()=>{});await assert.rejects(work,error=>error?.code===(loss==='exit'?'STORAGE_FAILURE':'CLOSED'));await tick();
  assert.equal(checks,at==='second'?2:1);assert.equal(f.ports.length,1,'Lost ready ownership must never fall back to ensure');assert.equal(port.sent.length,sent,'No text job may dispatch after losing its ready generation');assert.equal(f.owner.readyIdentity,null);
 }finally{await closing?.catch(()=>{});await f.owner.close();}
});

test('a stale pinned continuation cannot terminate the replacement job started after actual exit',async()=>{
 const f=fixture();let replacement,stale;
 try{
  const old=await idle(f),lease=f.owner.readyIdentity,oldSent=old.sent.length;let checks=0;
  stale=f.owner.run(job,'display:stale',{...f.hooks,check(){if(++checks===1)queueMicrotask(()=>{
   old.emit('exit',1);replacement=f.owner.run(job,'history:replacement',f.hooks);replacement.catch(()=>{});
  });}},lease);stale.catch(()=>{});
  await assert.rejects(stale,error=>error?.code==='STORAGE_FAILURE');await tick();
  assert.equal(f.ports.length,2);const current=f.ports[1];assert.equal(old.sent.length,oldSent);assert.equal(current.terminated,0,'Old catch must not fail the newer pending owner');
  assert.equal(f.owner.snapshot.slot,'history:replacement');assert.equal(current.sent.filter(row=>row.type==='run').length,1);
  current.reply('plan',{plan});current.reply('result',{result,telemetry});current.reply('idle',{completed:true,retainedJobReferences:0});assert.equal(await replacement,result);assert.equal(current.terminated,0);
 }finally{await f.owner.close();await stale?.catch(()=>{});await replacement?.catch(()=>{});}
});


for(const [name,loss]of [
 ['a queued ready message is drained immediately before actual exit','exit'],
 ['close starts after ready and before its await continuation','close'],
 ['native failure starts termination after ready and before its await continuation','error'],
])test('restart rejects a replacement when '+name,async()=>{
 const baseline=allocationLedger.snapshot(),options={autoReady:true},f=fixture(options);let restart,finish,closing;
 try{
  const old=await idle(f),oldLease=f.owner.readyIdentity,observed=f.observed.length;
  options.autoReady=false;restart=f.owner.restartIdle(f.owner.snapshot.generation);restart.catch(()=>{});await tick();
  assert.equal(f.ports.length,2);assert.equal(old.terminated,1);const next=f.ports[1];
  assert.equal(f.owner.snapshot.restarting,true);assert.equal(f.owner.readyIdentity,null);assert.deepEqual(next.sent,[]);
  if(loss!=='exit')finish=holdTermination(next);
  // Node's Worker [kOnExit] drains queued public-port messages before emitting
  // exit in the same callback. Do not yield between ready and its loss: this
  // models that documented-in-source ordering, not a measured native timing.
  next.ready();
  if(loss==='exit')next.emit('exit',1);
  else if(loss==='close'){closing=f.owner.close();closing.catch(()=>{});}
  else next.emit('error',Error('native failure after queued readiness'));
  await assert.rejects(restart,error=>error?.code==='CLOSED');
  assert.equal(f.owner.snapshot.restarting,false);assert.equal(f.owner.snapshot.activeJobs,0);assert.equal(f.owner.snapshot.completedJobs,1);assert.equal(f.owner.readyIdentity,null);
  assert.equal(f.ports.length,2,'A lost restart replacement must not trigger another cold launch');assert.deepEqual(next.sent,[],'Restart cannot dispatch a dummy job');assert.equal(f.observed.length,observed);
  await rejectReady(f,oldLease,loss==='close'?'CLOSED':'CAPACITY');
  if(loss==='exit'){assert.equal(next.terminated,0);assert.equal(f.owner.snapshot.workerCount,0);assert.equal(f.owner.snapshot.identity,null);}
  else{
   assert.equal(next.terminated,1);assert.equal(f.owner.snapshot.workerCount,1);assert.equal(f.owner.snapshot.closed,loss==='close');
   assert.ok(allocationLedger.snapshot().cpuBytes>=baseline.cpuBytes+RASTER_DIAGNOSTIC_BYTES,'A rejected restart must retain the replacement grant until actual exit');
   finish();finish=undefined;await closing;await tick();assert.equal(f.owner.snapshot.workerCount,0);assert.equal(f.owner.snapshot.identity,null);assert.equal(f.owner.readyIdentity,null);
  }
 }finally{finish?.();await closing?.catch(()=>{});await f.owner.close();await restart?.catch(()=>{});}
 assert.equal(allocationLedger.snapshot().cpuBytes,baseline.cpuBytes);assert.equal(allocationLedger.snapshot().handles,baseline.handles);
});

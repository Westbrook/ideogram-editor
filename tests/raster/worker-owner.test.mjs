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
const {RasterWorkerOwner}=await import(await module('server/raster/worker-owner.ts',{'./worker-protocol.js':protocol,'../storage/errors.js':errors}));
let nextThread=1;
class Port extends EventEmitter {
 constructor(generation){super();this.generation=generation;this.threadId=nextThread++;this.sent=[];this.terminated=0;queueMicrotask(()=>this.emit('message',{type:'ready',protocolVersion:1,generation,threadId:this.threadId,startedMs:1,clockOriginUnixMs:2}));}
 postMessage(value){this.sent.push(value);}
 async terminate(){this.terminated++;this.emit('exit',1);return 1;}
 reply(type,extra={}){const job=this.sent.findLast(value=>value.type==='run');this.emit('message',{type,generation:this.generation,jobId:job?.jobId,...extra});}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const fixture=()=>{
 const ports=[],observed=[];
 return {
  ports,observed,
  owner:new RasterWorkerOwner(generation=>{const port=new Port(generation);ports.push(port);return port;}),
  hooks:{
   check(){},
   admit(plan){observed.push(['admit',plan]);},
   telemetry(value){observed.push(['telemetry',value]);},
   failure(message){return Object.assign(Error(message.code),{code:message.code});},
  },
 };
};
const job={type:'compose',directory:'/owned/job',width:1,height:1,layers:[],inputs:[],dependencies:[]};
const plan={cpuBytes:1,diskBytes:1},result={metrics:{},plan,telemetry:{schemaVersion:1}};
async function run(f,slot='history:a'){const work=f.owner.run(job,slot,f.hooks);work.catch(()=>{});await tick();const port=f.ports.at(-1);port.reply('plan',{plan});port.reply('result',{result});return {work,port};}

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

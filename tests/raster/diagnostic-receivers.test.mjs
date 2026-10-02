import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {transformWithOxc} from 'vite';
import {diagnosticMemoryURL,allocationsURL,phasesURL} from '../owned-preview-module.mjs';
const root=process.env.SERVER_DIAGNOSTIC_STAGED_ROOT??'.';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const coreURL=data((await transformWithOxc(await readFile(join(root,'src/raster/core.ts'),'utf8'),'core.ts')).code);
const resourcePlanURL=data((await transformWithOxc(await readFile(join(root,'server/raster/resource-plan.ts'),'utf8'),'resource-plan.ts')).code.replaceAll('../../src/raster/core.js',coreURL));
async function module(path){let code=(await transformWithOxc(await readFile(join(root,path),'utf8'),path)).code;for(const [from,to]of [['../../src/observability/diagnostic-memory.js',diagnosticMemoryURL],['../../src/observability/phases.js',phasesURL],['./resource-plan.js',resourcePlanURL]])code=code.replaceAll(from,to);return import(data(code));}
const {AllocationLedger,allocationLedger}=await import(allocationsURL);
const {DiagnosticMemory,reserveBorrowedDiagnostics}=await import(diagnosticMemoryURL);
const {DiagnosticReceiver,DiagnosticRing,diagnosticReleases,withDiagnosticDirectory,closeDiagnosticDirectories}=await module('server/observability/diagnostic-memory.ts');
const {ActiveCompute}=await module('server/raster/active-compute.ts');
const isolated=()=>{const ledger=new AllocationLedger(),memory=new DiagnosticMemory();memory.adopt(value=>ledger.reserve(value));return {ledger,memory};};

test('receiver admits before native dispatch and refuses fifth pending or live consumer',()=>{
 const {ledger,memory}=isolated(),receiver=new DiagnosticReceiver('receiver-test',1024,4,memory),owners=[];
 try{for(let i=0;i<4;i++)owners.push(receiver.admit());assert.equal(ledger.snapshot().cpuBytes,4*(3072+65536));assert.equal(ledger.snapshot().handles,4);assert.throws(()=>receiver.admit(),/DIAGNOSTIC_READ_LIMIT/);
  const read=owners[0].receive({value:'owned'});assert.throws(()=>receiver.admit(),/DIAGNOSTIC_READ_LIMIT/);read.release();assert.throws(()=>read.value,/RELEASED/);
 }finally{receiver.nativeExited();}assert.equal(ledger.snapshot().activeRecords,0);
});
test('native exit refunds unfinished requests but never an already delivered consumer',()=>{
 const {ledger,memory}=isolated(),receiver=new DiagnosticReceiver('receiver-test',1024,4,memory),pending=receiver.admit(),delivered=receiver.admit(),value={nested:{value:7}},read=delivered.receive(value);
 receiver.close();receiver.nativeExited();assert.equal(pending.pending,false);assert.equal(receiver.active,1);assert.equal(read.value,value);assert.equal(ledger.snapshot().activeRecords,1);assert.throws(()=>receiver.admit(),/CLOSED/);read.release();read.release();assert.equal(ledger.snapshot().activeRecords,0);
});
test('oversize native reply stays admitted until the actual response is discarded',()=>{
 const {ledger,memory}=isolated(),receiver=new DiagnosticReceiver('receiver-test',64,1,memory),ticket=receiver.admit();
 assert.throws(()=>ticket.receive({value:'x'.repeat(100)}),/DIAGNOSTIC_RECEIVER_SIZE/);assert.equal(ticket.pending,true);assert.equal(ledger.snapshot().activeRecords,1);ticket.settledWithoutValue();assert.equal(ledger.snapshot().activeRecords,0);
});
test('ring rejects oversized successor without cloning or replacing its prior retained row',()=>{
 const {ledger,memory}=isolated(),ring=new DiagnosticRing('ring-test',2,256,memory);ring.add({value:'prior'});const before=ledger.snapshot().cpuBytes;
 assert.equal(ring.add({value:'x'.repeat(100)}),false);assert.equal(ledger.snapshot().cpuBytes,before);const read=ring.read();try{assert.deepEqual(read.value,[{value:'prior'}]);assert.equal(ring.dropped,1);ring.dispose();assert.deepEqual(read.value,[{value:'prior'}]);assert.equal(ledger.snapshot().activeRecords,1);}finally{read.release();ring.dispose();}assert.equal(ledger.snapshot().activeRecords,0);
});
test('persistent ring capacity is refused before any retained clone and can retry',()=>{
 const {ledger,memory}=isolated(),ring=new DiagnosticRing('ring-test',2,256,memory),blocker=ledger.reserve({owner:'blocker',kind:'control',cpuBytes:384*1024**2});
 let reads=0;const value={};Object.defineProperty(value,'value',{enumerable:true,get(){reads++;throw Error('getter');}});
 assert.throws(()=>ring.add(value),/ALLOCATION_BUDGET/);assert.equal(reads,0);blocker.release();ring.add({value:'accepted'});ring.dispose();assert.equal(ledger.snapshot().activeRecords,0);
});
test('ActiveCompute capacity is admitted before clocks and explicit reads survive producer disposal',()=>{
 const {ledger,memory}=isolated(),blocker=ledger.reserve({owner:'blocker',kind:'control',cpuBytes:384*1024**2});let clocks=0;
 assert.throws(()=>new ActiveCompute({memory,now:()=>{clocks++;return 1;}}),/ALLOCATION_BUDGET/);assert.equal(clocks,0);blocker.release();
 let now=1;const active=new ActiveCompute({memory,now:()=>now,wallNow:()=>100});active.run('fold',()=>{now=3;});assert.equal(active.finish(),'completed');const read=active.readSnapshot();active.dispose();assert.equal(read.value.unionMs,2);assert.equal(ledger.snapshot().activeRecords,1);assert.throws(()=>active.readSnapshot(),/DISPOSED/);read.release();assert.equal(ledger.snapshot().activeRecords,0);
});
test('fixed nested delegation cannot enlarge and parent refund remains explicit',()=>{
 const {ledger}=isolated(),parent=ledger.reserve({owner:'parent-worker',kind:'control',cpuBytes:1024,handles:1}),memory=new DiagnosticMemory();memory.adopt(reserveBorrowedDiagnostics(1024));
 const child=memory.reserve('child',1024);assert.throws(()=>memory.reserve('excess',1),/BORROW_LIMIT/);child.release();assert.equal(ledger.snapshot().cpuBytes,1024);parent.release();assert.equal(ledger.snapshot().cpuBytes,0);
});
test('independent cleanup preserves falsey failure and retries only failed owners',()=>{
 let attempts=0,other=0;const release=diagnosticReleases([{release(){if(++attempts===1)throw undefined;}},{release(){other++;}}]);
 assert.throws(release,error=>error instanceof AggregateError&&error.errors.length===1&&error.errors[0]===undefined);assert.equal(other,1);release();release();assert.equal(attempts,2);assert.equal(other,1);
});
test('real directory handle closes on a falsey visitor failure with baseline restored',async()=>{
 const path=await mkdtemp(join(tmpdir(),'diagnostic-directory-')),baseline=allocationLedger.snapshot();
 try{assert.throws(()=>withDiagnosticDirectory(path,()=>{throw 0;}),error=>error===0);assert.equal(allocationLedger.snapshot().cpuBytes,baseline.cpuBytes);assert.equal(allocationLedger.snapshot().handles,baseline.handles);}finally{await rm(path,{recursive:true,force:true});}
});

test('failed directory close retains exact native handle and reservation for retry',async()=>{
 const path=await mkdtemp(join(tmpdir(),'diagnostic-directory-retry-')),baseline=allocationLedger.snapshot();let directory,close;
 try{assert.throws(()=>withDiagnosticDirectory(path,value=>{directory=value;close=value.closeSync.bind(value);value.closeSync=()=>{throw 0;};}),error=>error===0);
  assert.equal(allocationLedger.snapshot().handles,baseline.handles+1);directory.closeSync=close;closeDiagnosticDirectories();assert.equal(allocationLedger.snapshot().cpuBytes,baseline.cpuBytes);assert.equal(allocationLedger.snapshot().handles,baseline.handles);
 }finally{if(directory&&close)directory.closeSync=close;closeDiagnosticDirectories();await rm(path,{recursive:true,force:true});}
});
test('directory admission refuses before native open rather than relying on an open error',()=>{
 const baseline=allocationLedger.snapshot(),blocker=allocationLedger.reserve({owner:'directory-pressure',kind:'control',cpuBytes:384*1024**2-baseline.cpuBytes});
 try{assert.throws(()=>withDiagnosticDirectory('/nonexistent/diagnostic-admission-proof',()=>{}),/ALLOCATION_BUDGET/);}finally{blocker.release();}assert.equal(allocationLedger.snapshot().cpuBytes,baseline.cpuBytes);
});
test('a bounded total-byte ring evicts enough old records before adopting the next admitted row',()=>{
 const {ledger,memory}=isolated(),ring=new DiagnosticRing('byte-ring',3,256,memory,300);
 ring.add({value:'a'.repeat(10)});ring.add({value:'b'.repeat(10)});const read=ring.read();
 try{assert.deepEqual(read.value,[{value:'b'.repeat(10)}]);assert.equal(ring.dropped,1);}finally{read.release();ring.dispose();}assert.equal(ledger.snapshot().activeRecords,0);
});

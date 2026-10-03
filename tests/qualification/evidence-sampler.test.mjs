import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath,lstat,opendir,open,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {loadAllocation,sampleVolume,startEvidenceMonitor,retainEvidenceAudit,verifyEvidenceAudit} from '../../tooling/qualification/evidence-volume.mjs';

const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function within(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Observation did not reach the intended boundary')),5000);})]);}finally{clearTimeout(timer);}}
async function fixture(t,files=0){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ideogram-evidence-sampler-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const volume=join(root,'volume');await mkdir(volume,{mode:0o700});const output=files?volume:join(volume,'run');if(!files)await mkdir(output);
 for(let i=0;i<files;i++)await writeFile(join(output,'entry-'+i),String(i));
 const path=join(root,'allocation.json');await writeFile(path,JSON.stringify({kind:'evidence-volume-allocation-1',allocationId:'sample-fixture',purpose:'qualification-evidence-only',capacityBytes:34359738368,root:volume,issuedAt:'2026-09-30T00:00:00.000Z',owner:'Build'}));
 return {root,volume,output,path,allocation:await loadAllocation(path)};
}
function directories(){const handles=[];return {handles,async openDirectory(path){const handle=await opendir(path);handles.push(handle);return handle;}};}
async function closed(handles){for(const handle of handles)await assert.rejects(handle.read(),{code:'ERR_DIR_CLOSED'});}

test('traversal admits four real file observations and drains before directory post-stat',async t=>{
 const f=await fixture(t,20),held=gate(),entered=gate(),dirs=directories();let active=0,peak=0,starts=0,postWhileActive=false;const visits=new Map();
 const pending=sampleVolume(f.allocation,{openDirectory:dirs.openDirectory,async statEntry(path,options){
  const before=await lstat(path,options),count=(visits.get(path)??0)+1;visits.set(path,count);
  if(before.isDirectory()&&count===2&&active)postWhileActive=true;
  if(before.isFile()&&count===1){active++;peak=Math.max(peak,active);starts++;if(active===4)entered.resolve();try{await held.promise;}finally{active--;}}
  return before;
 }});
 try{await within(entered.promise);assert.equal(peak,4);assert.equal(starts,4);held.resolve();const result=await pending;assert.equal(result.completeTraversal,true);assert.equal(result.entries,21);assert.equal(result.uniqueFiles,20);assert.equal(postWhileActive,false);assert.equal(active,0);assert.equal(peak,4);await closed(dirs.handles);}
 finally{held.resolve();await pending;}
});

test('single-child ancestors preserve four file observations, inode accounting and post-order checks',async t=>{
 const f=await fixture(t),leaf=join(f.output,'one','two','three');await mkdir(leaf,{recursive:true});
 for(let i=0;i<20;i++)await writeFile(join(leaf,'entry-'+i),String(i));
 await link(join(leaf,'entry-0'),join(leaf,'alias'));
 const held=gate(),entered=gate(),dirs=directories(),visits=new Map();let active=0,peak=0,starts=0,postWhileActive=false;
 const pending=sampleVolume(f.allocation,{openDirectory:dirs.openDirectory,async statEntry(path,options){
  const before=await lstat(path,options),count=(visits.get(path)??0)+1;visits.set(path,count);
  if(before.isDirectory()&&count===2&&active)postWhileActive=true;
  if(before.isFile()&&count===1){active++;peak=Math.max(peak,active);starts++;if(active===4)entered.resolve();try{await held.promise;}finally{active--;}}
  return before;
 }});
 try{
  await within(entered.promise);assert.equal(peak,4);assert.equal(starts,4);held.resolve();const result=await pending;
  assert.equal(result.completeTraversal,true);assert.equal(result.entries,26);assert.equal(result.uniqueFiles,20);assert.equal(result.repeatedInodes,1);assert.equal(result.observedLogicalBytes,30);
  assert.equal(postWhileActive,false);assert.equal(active,0);assert.equal(peak,4);assert.equal(visits.size,26);for(const count of visits.values())assert.equal(count,2);
  const inodes=new Set();let allocated=0n;for(const path of visits.keys()){const value=await lstat(path,{bigint:true}),inode=`${value.dev}:${value.ino}`;if(!inodes.has(inode)){inodes.add(inode);allocated+=value.blocks*512n;}}
  assert.equal(result.observedAllocatedBytes,Number(allocated));await closed(dirs.handles);
 }finally{held.resolve();await pending;}
});

for(const [label,failure]of [['Error',Object.assign(Error('stat failure'),{code:'EIO'})],['undefined',undefined]])test('first '+label+' failure retains incomplete sample and drains sibling reads/directories',async t=>{
 const f=await fixture(t,12),held=gate(),entered=gate(),failed=gate(),dirs=directories();let fileCalls=0,active=0,settled=false;
 const pending=sampleVolume(f.allocation,{openDirectory:dirs.openDirectory,async statEntry(path,options){const value=await lstat(path,options);if(value.isFile()){fileCalls++;if(fileCalls===1){active++;entered.resolve();try{await held.promise;}finally{active--;}}else if(fileCalls===2){failed.resolve();throw failure;}}return value;}}).then(value=>{settled=true;return value;});
 try{await within(Promise.all([entered.promise,failed.promise]));await Promise.resolve();assert.equal(settled,false);assert.equal(active,1);held.resolve();const result=await pending;assert.equal(result.completeTraversal,false);assert.equal(result.failures.length,1);assert.equal(result.failures[0].code,label==='Error'?'EIO':'EVIDENCE_IO');assert.equal(active,0);await closed(dirs.handles);}
 finally{held.resolve();await pending;}
});

test('parallel entry-bound refusal stays at one sentinel and drains actual handles',async t=>{
 const f=await fixture(t,24),dirs=directories();let calls=0;
 const result=await sampleVolume(f.allocation,{maxEntries:5,openDirectory:dirs.openDirectory,statEntry:async(...args)=>{calls++;return lstat(...args);}});
 assert.equal(result.completeTraversal,false);assert.equal(result.entries,6);assert.equal(result.failures.length,1);assert.equal(result.failures[0].code,'EVIDENCE_BOUND');assert(calls<=10,'Only the five admitted entries may receive pre/post stats');await closed(dirs.handles);
});

// Timers/monotonic time are controlled; allocation, scans, journal writes and
// descriptor cleanup are real. These are scheduling tests, not timing evidence.
function clock(t){
 let now=0;const timers=new Set(),waiters=[];
 t.mock.method(performance,'now',()=>now);
 t.mock.method(globalThis,'setTimeout',(callback,delay)=>{const timer={callback,delay,unref(){}};timers.add(timer);for(const done of waiters.splice(0))done(timer);return timer;});
 t.mock.method(globalThis,'clearTimeout',timer=>timers.delete(timer));
 return {timers,set(value){now=value;},async next(){if(timers.size)return timers.values().next().value;return new Promise(done=>waiters.push(done));},fire(timer){assert(timers.delete(timer));timer.callback();}};
}

test('overdue completion schedules one immediate sample then uses its actual-start deadline',async t=>{
 const f=await fixture(t),time=clock(t);let syncs=0,descriptor,monitor;
 try{
  monitor=await startEvidenceMonitor({allocationPath:f.path,output:f.output,campaignId:'cadence-overrun',intervalMs:2000,openJournal:async path=>{descriptor=await open(path,'wx',0o600);return {writeFile:(...args)=>descriptor.writeFile(...args),close:()=>descriptor.close(),async sync(){await descriptor.sync();syncs++;time.set(syncs===1?2500:2600);}};}});
  const first=await time.next();assert.equal(first.delay,0);assert.equal(time.timers.size,1);time.fire(first);
  const second=await time.next();assert.equal(second.delay,1900);assert.equal(time.timers.size,1);assert.equal(syncs,2);
 }finally{if(monitor)await monitor.finish();}
 assert.equal(time.timers.size,0);await assert.rejects(descriptor.stat(),/closed|EBADF/);
});

test('finish while periodic journal sync is held cannot rearm or overlap observations',async t=>{
 const f=await fixture(t),time=clock(t),held=gate(),busy=gate();let syncs=0,active=0,peak=0,descriptor,monitor,finished;
 try{
  monitor=await startEvidenceMonitor({allocationPath:f.path,output:f.output,campaignId:'cadence-finish',intervalMs:2000,openJournal:async path=>{descriptor=await open(path,'wx',0o600);return {writeFile:(...args)=>descriptor.writeFile(...args),close:()=>descriptor.close(),async sync(){active++;peak=Math.max(peak,active);try{syncs++;if(syncs===2){busy.resolve();await held.promise;}await descriptor.sync();}finally{active--;}}};}});
  const receiptPath=join(f.output,'receipt.json');await writeFile(receiptPath,JSON.stringify({receiptId:'cadence-finish',groups:[],evidenceStorage:monitor.reference}));
  const timer=await time.next();time.set(2000);time.fire(timer);await busy.promise;
  finished=monitor.finish({receiptPath});assert.throws(()=>monitor.checkpoint(),/closed/);await assert.rejects(monitor.finish(),/already finished/);held.resolve();await finished;
  assert.equal(syncs,3);assert.equal(peak,1);assert.equal(active,0);assert.equal(time.timers.size,0);await assert.rejects(descriptor.stat(),/closed|EBADF/);
  await retainEvidenceAudit(monitor.reference,f.output);assert.equal((await verifyEvidenceAudit(monitor.reference,receiptPath)).status,'PASS');
 }finally{held.resolve();if(finished)await finished;else if(monitor)await monitor.finish();}
});

test('journal failure stops automatic scheduling without overdue retry spin',async t=>{
 const f=await fixture(t),time=clock(t),failed=gate();let syncs=0,descriptor,monitor;
 try{
  monitor=await startEvidenceMonitor({allocationPath:f.path,output:f.output,campaignId:'cadence-failure',intervalMs:2000,openJournal:async path=>{descriptor=await open(path,'wx',0o600);return {writeFile:(...args)=>descriptor.writeFile(...args),close:()=>descriptor.close(),async sync(){if(++syncs===2){time.set(5000);failed.resolve();throw Error('journal sync failed');}await descriptor.sync();}};}});
  const timer=await time.next();time.set(2000);time.fire(timer);await failed.promise;await assert.rejects(monitor.checkpoint(),/journal sync failed/);assert.equal(time.timers.size,0);
  const audit=await monitor.finish();monitor=null;assert.equal(audit.status,'INCONCLUSIVE');assert.equal(audit.coverageComplete,false);assert.equal(syncs,2);await assert.rejects(descriptor.stat(),/closed|EBADF/);
 }finally{if(monitor)await monitor.finish();}
});


test('a real observed gap beyond two intervals stays inconclusive through retained replay',async t=>{
 const f=await fixture(t),time=clock(t);let syncs=0,descriptor,monitor,finished;
 try{
  monitor=await startEvidenceMonitor({allocationPath:f.path,output:f.output,campaignId:'cadence-gap',intervalMs:2000,openJournal:async path=>{descriptor=await open(path,'wx',0o600);return {writeFile:(...args)=>descriptor.writeFile(...args),close:()=>descriptor.close(),async sync(){await descriptor.sync();if(++syncs===1)time.set(5000);}};}});
  const receiptPath=join(f.output,'receipt.json');await writeFile(receiptPath,JSON.stringify({receiptId:'cadence-gap',groups:[],evidenceStorage:monitor.reference}));
  const overdue=await time.next();assert.equal(overdue.delay,0);time.fire(overdue);await time.next();
  finished=monitor.finish({receiptPath});const audit=await finished;
  assert.equal(audit.maximumGapMs,5000);assert.equal(audit.unknownSamples,0);assert.equal(audit.coverageComplete,false);assert.equal(audit.status,'INCONCLUSIVE');assert.equal(audit.qualification,false);
  await retainEvidenceAudit(monitor.reference,f.output);assert.equal((await verifyEvidenceAudit(monitor.reference,receiptPath)).status,'INCONCLUSIVE');assert.equal(time.timers.size,0);await assert.rejects(descriptor.stat(),/closed|EBADF/);
 }finally{if(finished)await finished;else if(monitor)await monitor.finish();}
});

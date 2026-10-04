import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
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

function observeDefaultStats(t,observe){
 const original=fs.lstatSync,stub=t.mock.method(fs,'lstatSync',(...args)=>observe(original,...args));syncBuiltinESMExports();
 return ()=>{stub.mock.restore();syncBuiltinESMExports();};
}
// Finite real fixture entries without intervening read I/O turns. The native
// handles still close through iterator return, including a sibling's failure.
function bufferedDirectories(){
 const handles=[];return {handles,async openDirectory(path){
  const handle=await opendir(path);handles.push(handle);
  return (async function*(){try{const entries=[];for(let entry=handle.readSync();entry;entry=handle.readSync())entries.push(entry);entries.sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory()));yield* entries;}finally{await handle.close();}})();
 }};
}

// Observe real native directory handles on the optimized default path. Faults
// below are test-owned; ordinary operations still use the original filesystem.
function observeDefaultDirectories(t,{beforeOpen=()=>{},beforeRead=()=>{},afterClose=()=>{}}={}){
 const records=[],original=fs.opendirSync;
 const stub=t.mock.method(fs,'opendirSync',(path,options)=>{
  beforeOpen(path);const handle=original(path,options),record={path,handle,yielded:0,closeCalls:0,closed:false};records.push(record);
  const read=handle.readSync.bind(handle),close=handle.closeSync.bind(handle);
  t.mock.method(handle,'readSync',()=>{beforeRead(record);const entry=read();if(entry!==null)record.yielded++;return entry;});
  t.mock.method(handle,'closeSync',()=>{record.closeCalls++;const result=close();record.closed=true;afterClose(record);return result;});
  return handle;
 });syncBuiltinESMExports();
 return {records,restore(){stub.mock.restore();syncBuiltinESMExports();}};
}

test('default directory stream counts every entry without pre-enumeration and closes before post-stat',async t=>{
 const f=await fixture(t,70),leaf=join(f.volume,'branch','leaf');await mkdir(leaf,{recursive:true});await mkdir(join(f.volume,'empty'));
 await writeFile(join(leaf,'payload'),Buffer.alloc(7));await link(join(f.volume,'entry-0'),join(f.volume,'alias'));
 const dirs=observeDefaultDirectories(t),visits=new Map(),beforeStats=new Map(),order=[];let firstFileReadAhead;
 const restore=observeDefaultStats(t,(original,path,options)=>{
  const value=original(path,options),count=(visits.get(path)??0)+1;visits.set(path,count);order.push({path,count});
  if(count===1)beforeStats.set(path,value);
  if(value.isFile()&&count===1&&firstFileReadAhead===undefined)firstFileReadAhead=dirs.records.find(record=>record.path===f.volume).yielded;
  if(value.isDirectory()&&count===2)assert.equal(dirs.records.find(record=>record.path===path).closed,true,'Directory closes before its post-stat');
  return value;
 });
 try{
  const result=await sampleVolume(f.allocation);
  assert.equal(result.completeTraversal,true);assert.equal(result.entries,76);assert.equal(result.uniqueFiles,71);assert.equal(result.repeatedInodes,1);assert.equal(result.observedLogicalBytes,137);assert.deepEqual(result.failures,[]);
  assert(firstFileReadAhead<70,'A real child is observed before the directory is fully enumerated');
  assert.equal(visits.size,76);for(const count of visits.values())assert.equal(count,2);
  for(const directory of dirs.records){
   const parentPost=order.findIndex(item=>item.path===directory.path&&item.count===2);
   for(const [index,item]of order.entries())if(item.path.startsWith(directory.path+'/'))assert(index<parentPost,'Every descendant completes before its ancestor post-stat');
   assert.equal(directory.closeCalls,1);assert.equal(directory.closed,true);
  }
  const seen=new Set();let allocated=0n;for(const value of beforeStats.values()){const inode=`${value.dev}:${value.ino}`;if(!seen.has(inode)){seen.add(inode);allocated+=value.blocks*512n;}}assert.equal(result.observedAllocatedBytes,Number(allocated));
  await closed(dirs.records.map(record=>record.handle));
 }finally{restore();dirs.restore();}
});

for(const readFailure of [false,true])test('default directory traversal yields at the shared stat bound '+(readFailure?'and drains a subsequent read failure':'before completing'),async t=>{
 const f=await fixture(t,96),observed=gate();let calls=0,queued=false,failReads=false,settled=false;
 const dirs=observeDefaultDirectories(t,{beforeRead(){if(failReads)throw Object.assign(Error('test-owned read failure'),{code:'EIO'});}});
 const restore=observeDefaultStats(t,(original,path,options)=>{
  const value=original(path,options);calls++;
  if(value.isFile()&&!queued){queued=true;setImmediate(()=>{failReads=readFailure;observed.resolve({calls,settled});});}
  return value;
 });
 const pending=sampleVolume(f.allocation).then(result=>{settled=true;return result;});
 try{
  const boundary=await within(observed.promise);assert.equal(boundary.settled,false);assert.equal(boundary.calls,32);
  const result=await pending;assert.equal(result.completeTraversal,!readFailure);
  if(readFailure){assert.deepEqual(result.failures.map(value=>value.code),['EIO']);assert.match(result.failures[0].message,/phase=read-directory/);}
  else{assert.equal(result.entries,97);assert.equal(result.uniqueFiles,96);assert.deepEqual(result.failures,[]);}
  assert(dirs.records.length>0);for(const record of dirs.records){assert.equal(record.closeCalls,1);assert.equal(record.closed,true);}await closed(dirs.records.map(record=>record.handle));
 }finally{try{await pending;}finally{restore();dirs.restore();}}
});

for(const phase of ['open','read','close'])test('default native directory '+phase+' failure retains its phase and closes every opened handle',async t=>{
 const f=await fixture(t,1),target=join(f.volume,'target');await mkdir(target);await writeFile(join(target,'payload'),'x');
 const code=phase==='open'?'EACCES':'EIO',fault=()=>{throw Object.assign(Error('private directory diagnostic'),{code});};
 const dirs=observeDefaultDirectories(t,{
  beforeOpen(path){if(phase==='open'&&path===target)fault();},
  beforeRead(record){if(phase==='read'&&record.path===target)fault();},
  afterClose(record){if(phase==='close'&&record.path===target)fault();},
 });
 try{
  const result=await sampleVolume(f.allocation);assert.equal(result.completeTraversal,false);assert.equal(result.failures.length,1);assert.equal(result.failures[0].code,code);
  assert.match(result.failures[0].message,new RegExp('phase='+(phase==='open'?'open-directory':'read-directory')));assert.match(result.failures[0].message,/member=target/);assert(!result.failures[0].message.includes('private directory diagnostic'));
  for(const record of dirs.records){assert.equal(record.closeCalls,1);assert.equal(record.closed,true);}await closed(dirs.records.map(record=>record.handle));
 }finally{dirs.restore();}
});

test('default IteratorClose preserves an entry-bound body failure over a closing failure',async t=>{
 const f=await fixture(t,6),dirs=observeDefaultDirectories(t,{afterClose(){throw Object.assign(Error('private close failure'),{code:'EIO'});}});
 try{
  const result=await sampleVolume(f.allocation,{maxEntries:1});
  assert.equal(result.completeTraversal,false);assert.equal(result.entries,2);assert.equal(result.uniqueFiles,0);
  assert.deepEqual(result.failures.map(value=>value.code),['EVIDENCE_BOUND']);
  assert.equal(dirs.records.length,1);assert.equal(dirs.records[0].closeCalls,1);assert.equal(dirs.records[0].closed,true);
  await closed(dirs.records.map(record=>record.handle));
 }finally{dirs.restore();}
});

test('default generator read failure retains its original finally-close error precedence',async t=>{
 const f=await fixture(t,1),dirs=observeDefaultDirectories(t,{
  beforeRead(){throw Object.assign(Error('private read failure'),{code:'EIO'});},
  afterClose(){throw Object.assign(Error('private close failure'),{code:'EACCES'});},
 });
 try{
  const result=await sampleVolume(f.allocation);assert.equal(result.completeTraversal,false);
  assert.deepEqual(result.failures.map(value=>value.code),['EACCES']);assert.match(result.failures[0].message,/phase=read-directory/);
  assert.equal(dirs.records.length,1);assert.equal(dirs.records[0].closeCalls,1);assert.equal(dirs.records[0].closed,true);
  await closed(dirs.records.map(record=>record.handle));
 }finally{dirs.restore();}
});

test('an explicit synchronous iterator still unwraps promise-valued directory entries',async t=>{
 const f=await fixture(t,6),handles=[];let closeCalls=0;
 const result=await sampleVolume(f.allocation,{async openDirectory(path){
  const handle=await opendir(path);handles.push(handle);
  return (function*(){try{for(let entry=handle.readSync();entry;entry=handle.readSync())yield Promise.resolve(entry);}finally{handle.closeSync();closeCalls++;}})();
 }});
 assert.equal(result.completeTraversal,true);assert.equal(result.entries,7);assert.equal(result.uniqueFiles,6);assert.deepEqual(result.failures,[]);
 assert.equal(closeCalls,1);await closed(handles);
});

test('an explicit async iterator return remains awaited while a bound failure drains',async t=>{
 const f=await fixture(t,6),handles=[],closing=gate(),release=gate();let closeCalls=0,settled=false;
 const pending=sampleVolume(f.allocation,{maxEntries:1,async openDirectory(path){
  const handle=await opendir(path);handles.push(handle);
  return {[Symbol.asyncIterator](){return this;},async next(){const entry=await handle.read();if(entry)return {value:entry,done:false};await handle.close();closeCalls++;return {done:true};},
   async return(){closing.resolve();await release.promise;await handle.close();closeCalls++;return {done:true};}};
 }}).then(result=>{settled=true;return result;});
 try{
  await within(closing.promise);assert.equal(settled,false);assert.equal(closeCalls,0);
  release.resolve();const result=await pending;assert.equal(result.completeTraversal,false);assert.equal(result.entries,2);
  assert.deepEqual(result.failures.map(value=>value.code),['EVIDENCE_BOUND']);assert.equal(closeCalls,1);await closed(handles);
 }finally{release.resolve();await pending;}
});

test('explicit stat injection retains the asynchronous default directory backend',async t=>{
 const f=await fixture(t,64),dirs=observeDefaultDirectories(t);let calls=0;
 try{
  const result=await sampleVolume(f.allocation,{statEntry(path,options){calls++;return fs.lstatSync(path,options);}});
  assert.equal(result.completeTraversal,true);assert.equal(result.entries,65);assert.equal(result.uniqueFiles,64);assert.equal(calls,130);assert.equal(dirs.records.length,0);assert.deepEqual(result.failures,[]);
 }finally{dirs.restore();}
});

test('explicit null directory injection remains invalid without selecting the synchronous default',async t=>{
 const f=await fixture(t,1),dirs=observeDefaultDirectories(t);
 try{
  const result=await sampleVolume(f.allocation,{openDirectory:null});assert.equal(result.completeTraversal,false);assert.equal(result.entries,1);assert.equal(dirs.records.length,0);assert.deepEqual(result.failures.map(value=>value.code),['EVIDENCE_IO']);assert.match(result.failures[0].message,/phase=open-directory/);
 }finally{dirs.restore();}
});

test('default sync observations preserve bigint pre/post checks and unique inode accounting',async t=>{
 const f=await fixture(t,20);await link(join(f.volume,'entry-0'),join(f.volume,'alias'));
 const dirs=directories(),visits=new Map(),order=[],stats=new Map();
 const restore=observeDefaultStats(t,(original,path,options)=>{assert.deepEqual(options,{bigint:true});const value=original(path,options);visits.set(path,(visits.get(path)??0)+1);order.push(path);stats.set(path,value);return value;});
 try{
  const result=await sampleVolume(f.allocation,{openDirectory:dirs.openDirectory});
  assert.equal(result.completeTraversal,true);assert.equal(result.entries,22);assert.equal(result.uniqueFiles,20);assert.equal(result.repeatedInodes,1);assert.equal(result.observedLogicalBytes,30);assert.equal(result.concurrentChanges,0);assert.deepEqual(result.failures,[]);
  assert.equal(visits.size,22);for(const count of visits.values())assert.equal(count,2);assert.equal(order[0],f.volume);assert.equal(order.at(-1),f.volume);
  const inodes=new Set();let allocated=0n;for(const value of stats.values()){const inode=`${value.dev}:${value.ino}`;if(!inodes.has(inode)){inodes.add(inode);allocated+=value.blocks*512n;}}assert.equal(result.observedAllocatedBytes,Number(allocated));await closed(dirs.handles);
 }finally{restore();}
});

for(const kind of ['error','file-identity'])test('default sync '+kind+' refusal retains its existing failure and closes directories',async t=>{
 const f=await fixture(t,1),dirs=directories(),visits=new Map();
 const restore=observeDefaultStats(t,(original,path,options)=>{
  const value=original(path,options),count=(visits.get(path)??0)+1;visits.set(path,count);
  if(value.isFile()&&kind==='error')throw Object.assign(Error('private sync failure'),{code:'EIO'});
  if(count===2&&kind==='file-identity'&&value.isFile())value.ino+=1n;
  return value;
 });
 try{
  const result=await sampleVolume(f.allocation,{openDirectory:dirs.openDirectory});assert.equal(result.completeTraversal,false);assert.equal(result.failures.length,1);
  assert.equal(result.failures[0].code,kind==='error'?'EIO':'EVIDENCE_MUTATION');await closed(dirs.handles);
 }finally{restore();}
});

test('explicit null stat injection remains invalid instead of selecting the default',async t=>{
 const f=await fixture(t,1);let defaults=0;
 const restore=observeDefaultStats(t,(original,...args)=>{defaults++;return original(...args);});
 try{const result=await sampleVolume(f.allocation,{statEntry:null});assert.equal(defaults,0);assert.equal(result.completeTraversal,false);assert.equal(result.entries,1);assert.deepEqual(result.failures.map(value=>value.code),['EVIDENCE_IO']);}
 finally{restore();}
});

test('explicit synchronous stat injection keeps its own scheduling and bypasses default sync stats',async t=>{
 const f=await fixture(t,64),dirs=bufferedDirectories(),original=fs.lstatSync,immediate=globalThis.setImmediate;let calls=0,defaults=0,yields=0;
 const restore=observeDefaultStats(t,()=>{defaults++;throw Error('Injected stats must bypass the default');});
 const scheduled=t.mock.method(globalThis,'setImmediate',(...args)=>{yields++;return immediate(...args);});
 try{
  const result=await sampleVolume(f.allocation,{openDirectory:dirs.openDirectory,statEntry(path,options){calls++;assert.deepEqual(options,{bigint:true});return original(path,options);}});
  assert.equal(result.completeTraversal,true);assert.equal(result.entries,65);assert.equal(calls,130);assert.equal(defaults,0);assert.equal(yields,0);await closed(dirs.handles);
 }finally{scheduled.mock.restore();restore();}
});

test('default sync traversal yields to a queued callback within 32 shared stat calls',async t=>{
 const f=await fixture(t,64),dirs=bufferedDirectories(),observed=gate();let calls=0,atCallback,settled=false,queued=false;
 const restore=observeDefaultStats(t,(original,path,options)=>{
  const value=original(path,options);calls++;
  if(value.isFile()&&!queued){queued=true;setImmediate(()=>{atCallback={calls,settled};observed.resolve();});}return value;
 });
 const pending=sampleVolume(f.allocation,{openDirectory:dirs.openDirectory}).then(result=>{settled=true;return result;});
 try{
  await within(observed.promise);assert.equal(atCallback.settled,false);assert.equal(atCallback.calls,32,'All traversal branches must share the same 32-call turn budget');
  const result=await pending;assert.equal(result.completeTraversal,true);assert.equal(result.entries,65);assert.equal(calls,130);await closed(dirs.handles);
 }finally{try{await pending;}finally{restore();}}
});

test('a sibling failure observed during the shared yield prevents every waiting default stat',async t=>{
 const f=await fixture(t,64),blocked=join(f.volume,'blocked');await mkdir(blocked);await writeFile(join(blocked,'entry'),'x');
 const dirs=bufferedDirectories(),entered=gate(),fail=gate(),yielded=gate(),failedDirectoryClosed=gate(),callbacks=[],immediate=globalThis.setImmediate;let calls=0,settled=false;
 const restore=observeDefaultStats(t,(original,...args)=>{calls++;return original(...args);});
 const scheduled=t.mock.method(globalThis,'setImmediate',callback=>{callbacks.push(callback);return immediate(()=>yielded.resolve());});
 const pending=sampleVolume(f.allocation,{async openDirectory(path){
  const entries=await dirs.openDirectory(path);if(path!==blocked)return entries;
  return (async function*(){try{for await(const entry of entries){entered.resolve();await fail.promise;throw Object.assign(Error('held directory read failed'),{code:'EIO'});}}finally{failedDirectoryClosed.resolve();}})();
 }}).then(result=>{settled=true;return result;});
 try{
  await within(Promise.all([entered.promise,yielded.promise]));assert.equal(callbacks.length,1);assert.equal(calls,32);assert.equal(settled,false);
  fail.resolve();await within(failedDirectoryClosed.promise);await new Promise(resolve=>immediate(resolve));
  assert.equal(calls,32);assert.equal(settled,false,'Issued siblings must remain drained behind the held barrier');
  for(const callback of callbacks.splice(0))immediate(callback);
  const result=await pending;assert.equal(result.completeTraversal,false);assert.equal(result.failures.length,1);assert.equal(result.failures[0].code,'EIO');assert.equal(calls,32,'No default stat may start after the sibling failure was observed');await closed(dirs.handles);
 }finally{fail.resolve();scheduled.mock.restore();for(const callback of callbacks.splice(0))immediate(callback);try{await pending;}finally{restore();}}
});

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

// Isolate each exact bigint mutation witness from identity/type changes. A file
// remains a non-atomic byte observation; changed directory membership is refused.
for(const kind of ['file','directory'])for(const field of ['size','mtimeNs','ctimeNs'])test(kind+' '+field+' change preserves exact post-stat mutation behavior',async t=>{
 const f=await fixture(t,1),target=kind==='file'?join(f.volume,'entry-0'):f.volume,dirs=directories(),visits=new Map();
 const result=await sampleVolume(f.allocation,{openDirectory:dirs.openDirectory,async statEntry(path,options){
  const value=await lstat(path,options),count=(visits.get(path)??0)+1;visits.set(path,count);
  if(path===target&&count===2){assert.equal(typeof value[field],'bigint');value[field]+=1n;}
  return value;
 }});
 assert.equal(result.entries,2);assert.equal(result.uniqueFiles,1);assert.equal(result.observedLogicalBytes,1);assert.equal(result.concurrentChanges,1);
 assert.equal(result.completeTraversal,kind==='file');assert.deepEqual(result.failures.map(value=>value.code),kind==='file'?[]:['EVIDENCE_MUTATION']);
 assert.equal(visits.size,2);for(const count of visits.values())assert.equal(count,2);await closed(dirs.handles);
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

// Synthetic post-stat deltas exercise refusal diagnostics, not a new scan policy
// or a measured explanation for any historical filesystem mutation.
for(const kind of ['file','directory'])for(const [field,mask]of [['size','10'],['mtimeNs','20'],['ctimeNs','40']])test('comparison diagnostic isolates '+kind+' '+field+' without changing admission',async t=>{
 const f=await fixture(t,1),target=kind==='file'?join(f.volume,'entry-0'):f.volume,dirs=directories(),visits=new Map();
 const result=await sampleVolume(f.allocation,{openDirectory:dirs.openDirectory,async statEntry(path,options){
  const value=await lstat(path,options),count=(visits.get(path)??0)+1;visits.set(path,count);
  if(path===target&&count===2){assert.equal(typeof value[field],'bigint');value[field]+=1n;}
  return value;
 }});
 assert.equal(result.entries,2);assert.equal(result.uniqueFiles,1);assert.equal(result.observedLogicalBytes,1);assert.equal(result.concurrentChanges,1);
 assert.equal(result.completeTraversal,kind==='file');assert.equal(visits.size,2);for(const count of visits.values())assert.equal(count,2);
 if(kind==='file')assert.deepEqual(result.failures,[]);
 else assert.deepEqual(result.failures,[{code:'EVIDENCE_MUTATION',message:'Evidence observation unavailable; phase=identity; code=EVIDENCE_MUTATION; member=.; mutation-v1='+mask+'; kinds=directory>directory'}]);
 await closed(dirs.handles);
});

for(const [field,mask]of [['dev','01'],['ino','02']])test('comparison diagnostic preserves exact '+field+' identity above Number precision',async t=>{
 const f=await fixture(t,1),target=join(f.volume,'entry-0'),dirs=directories(),visits=new Map(),large=1n<<80n;
 const result=await sampleVolume(f.allocation,{openDirectory:dirs.openDirectory,async statEntry(path,options){
  const value=await lstat(path,options),count=(visits.get(path)??0)+1;visits.set(path,count);
  if(path===target)value[field]=large+(count===2?1n:0n);
  return value;
 }});
 assert.equal(result.completeTraversal,false);assert.equal(result.concurrentChanges,0);assert.equal(result.uniqueFiles,1);assert.equal(result.observedLogicalBytes,1);
 assert.deepEqual(result.failures,[{code:'EVIDENCE_MUTATION',message:'Evidence observation unavailable; phase=identity; code=EVIDENCE_MUTATION; member=entry-0; mutation-v1='+mask+'; kinds=file>file'}]);
 assert.equal(visits.get(target),2);assert(!JSON.stringify(result).includes(String(large)));await closed(dirs.handles);
});

for(const kind of ['file','directory'])test('comparison diagnostic distinguishes '+kind+' type replacement at the original identity refusal',async t=>{
 const f=await fixture(t,1),target=kind==='file'?join(f.volume,'entry-0'):join(f.volume,'child'),dirs=directories(),visits=new Map();
 if(kind==='directory')await mkdir(target);
 const result=await sampleVolume(f.allocation,{openDirectory:dirs.openDirectory,async statEntry(path,options){
  const value=await lstat(path,options),count=(visits.get(path)??0)+1;visits.set(path,count);
  if(path===target&&count===2){value.isDirectory=()=>kind==='file';value.isFile=()=>kind==='directory';}
  return value;
 }});
 assert.equal(result.completeTraversal,false);assert.equal(result.concurrentChanges,0);assert.equal(result.failures.length,1);assert.equal(result.failures[0].code,'EVIDENCE_MUTATION');
 assert(result.failures[0].message.endsWith('; mutation-v1=0c; kinds='+kind+'>'+(kind==='file'?'directory':'file')));
 assert.equal(visits.get(target),2);await closed(dirs.handles);
});

test('all seven comparison bits coexist without exposing native tuple values',async t=>{
 const f=await fixture(t,1),target=join(f.volume,'entry-0'),dirs=directories(),visits=new Map(),large=1n<<100n;
 const result=await sampleVolume(f.allocation,{openDirectory:dirs.openDirectory,async statEntry(path,options){
  const value=await lstat(path,options),count=(visits.get(path)??0)+1;visits.set(path,count);
  if(path===target){value.dev=large;value.ino=large+2n;if(count===2){for(const field of ['dev','ino','size','mtimeNs','ctimeNs'])value[field]+=1n;value.isDirectory=()=>true;value.isFile=()=>false;}}
  return value;
 }});
 assert.equal(result.completeTraversal,false);assert.equal(result.concurrentChanges,0,'Identity refusal still precedes metadata accounting');
 assert.deepEqual(result.failures,[{code:'EVIDENCE_MUTATION',message:'Evidence observation unavailable; phase=identity; code=EVIDENCE_MUTATION; member=entry-0; mutation-v1=7f; kinds=file>directory'}]);
 assert(!JSON.stringify(result).includes(String(large)));assert.equal(visits.get(target),2);await closed(dirs.handles);
});

for(const lateError of [false,true])test('comparison diagnostic drains a held sibling and preserves '+(lateError?'non-mutation priority':'the original mutation'),async t=>{
 const f=await fixture(t,12),held=gate(),entered=gate(),compared=gate(),dirs=directories(),visits=new Map();let first,second,active=0,settled=false;
 const pending=sampleVolume(f.allocation,{openDirectory:dirs.openDirectory,async statEntry(path,options){
  const value=await lstat(path,options),count=(visits.get(path)??0)+1;visits.set(path,count);
  if(value.isFile()&&count===1){
   if(!first){first=path;active++;entered.resolve();try{await held.promise;if(lateError)throw Object.assign(Error('private sibling detail'),{code:'EIO'});}finally{active--;}}
   else if(!second)second=path;
  }
  if(path===second&&count===2){value.ino+=1n;compared.resolve();}
  return value;
 }}).then(value=>{settled=true;return value;});
 // Attach a rejection handler before any assertion can leave the barrier held.
 const drained=pending.then(value=>({value}),error=>({error}));
 try{
  await within(Promise.all([entered.promise,compared.promise]));await Promise.resolve();assert.equal(settled,false);assert.equal(active,1);
  held.resolve();const outcome=await drained;if(outcome.error)throw outcome.error;const result=outcome.value;
  assert.equal(active,0);assert.equal(result.completeTraversal,false);assert.equal(result.failures.length,1);
  assert.equal(result.failures[0].code,lateError?'EIO':'EVIDENCE_MUTATION');assert(!result.failures[0].message.includes('private sibling detail'));
  if(lateError)assert(!result.failures[0].message.includes('mutation-v1'));
  else assert(result.failures[0].message.endsWith('; mutation-v1=02; kinds=file>file'));
  await closed(dirs.handles);
 }finally{held.resolve();await drained;}
});

test('an unavailable injected comparison description cannot mask the original mutation',async t=>{
 const f=await fixture(t,1),target=join(f.volume,'entry-0'),dirs=directories();let visits=0;
 const result=await sampleVolume(f.allocation,{openDirectory:dirs.openDirectory,async statEntry(path,options){
  const value=await lstat(path,options);
  if(path===target&&++visits===2){value.dev+=1n;value.isDirectory=()=>{throw Error('private injected kind detail');};}
  return value;
 }});
 // isFile() admits the post-stat type and dev short-circuits the existing
 // identity guard. Only the optional description encounters the throwing hook.
 assert.deepEqual(result.failures,[{code:'EVIDENCE_MUTATION',message:'Evidence observation unavailable; phase=identity; code=EVIDENCE_MUTATION; member=entry-0'}]);
 assert.equal(result.completeTraversal,false);assert.equal(result.concurrentChanges,0);assert.equal(visits,2);await closed(dirs.handles);
});

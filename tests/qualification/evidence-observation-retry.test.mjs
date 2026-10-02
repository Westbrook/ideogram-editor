// Deterministic correctness tests with real allocated-volume traversal and
// retained journals. Mocked clocks are not timing or qualification evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,lstat,opendir,symlink,utimes,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {loadAllocation,observeVolume,validateEvidenceObservation,startEvidenceMonitor,retainEvidenceAudit,verifyEvidenceAudit} from '../../tooling/qualification/evidence-volume.mjs';

const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const identity=value=>({bytes:Buffer.byteLength(value),sha256:digest(value)});
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ideogram-evidence-retry-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const volume=join(root,'volume');await mkdir(volume,{mode:0o700});await writeFile(join(volume,'seed.bin'),Buffer.alloc(8,7));
 const allocationPath=join(root,'allocation.json');await writeFile(allocationPath,JSON.stringify({kind:'evidence-volume-allocation-1',allocationId:'retry-fixture',purpose:'qualification-evidence-only',capacityBytes:34359738368,root:volume,issuedAt:'2026-09-30T00:00:00.000Z',owner:'Build'}));
 return {root,volume,allocationPath,allocation:await loadAllocation(allocationPath),output:join(volume,'run')};
}
function clock(t){
 let now=0;const timers=new Set();t.mock.method(performance,'now',()=>now);
 t.mock.method(globalThis,'setTimeout',(callback,delay)=>{const timer={callback,delay,unref(){}};timers.add(timer);return timer;});
 t.mock.method(globalThis,'clearTimeout',timer=>timers.delete(timer));
 return {set(value){assert(value>=now);now=value;},timers};
}
async function assertClosed(handles){for(const handle of handles)await assert.rejects(handle.read(),{code:'ERR_DIR_CLOSED'});}
function traversal(root,{mutations=0,onEnd=()=>{}}={}){
 let visits=0,starts=0;const handles=[];
 return {handles,get starts(){return starts;},sampleOptions:{
  async openDirectory(path){const handle=await opendir(path);handles.push(handle);return handle;},
  async statEntry(path,options){
   if(path===root){
    const visit=visits++,attempt=Math.floor(visit/2);
    if(visit%2===0){await assertClosed(handles);starts++;}
    else{
     if(attempt<mutations){
      await writeFile(join(root,'mutation-'+attempt),Buffer.alloc(17,attempt+1));
      // File creation changes membership; an explicit timestamp also makes the
      // post-stat witness deterministic on coarse timestamp filesystems.
      const changed=new Date(Date.UTC(2030,0,1,0,0,attempt+1));await utimes(root,changed,changed);
     }
     onEnd(attempt);
    }
   }
   return lstat(path,options);
  }
 }};
}
function verifyAttemptChain(observation){
 let previous=null;
 for(const [sequence,attempt]of observation.attempts.entries()){
  const {hash,...body}=attempt;assert.equal(attempt.sequence,sequence);assert.equal(attempt.previous,previous);assert.equal(hash,digest(body));previous=hash;
 }
}
function resealAttempts(observation){let previous=null;for(const [sequence,attempt]of observation.attempts.entries()){attempt.sequence=sequence;attempt.previous=previous;const {hash,...body}=attempt;attempt.hash=digest(body);previous=attempt.hash;}}
async function retain(t,{sampleOptions={},atFinish=200,time=clock(t)}={}){
 const f=await fixture(t);await mkdir(f.output);const options=typeof sampleOptions==='function'?sampleOptions(f,time):sampleOptions;
 const monitor=await startEvidenceMonitor({allocationPath:f.allocationPath,output:f.output,campaignId:'bounded-retry',intervalMs:2000,sampleOptions:options});
 const receiptPath=join(f.output,'receipt.json');await writeFile(receiptPath,JSON.stringify({receiptId:'bounded-retry',groups:[],evidenceStorage:monitor.reference}));
 time.set(atFinish);const audit=await monitor.finish({receiptPath});await retainEvidenceAudit(monitor.reference,f.output);
 const directory=join(f.output,'evidence-storage'),auditPath=join(directory,'audit.json'),journalPath=join(directory,'samples.jsonl');
 const records=(await readFile(journalPath,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(time.timers.size,0);return {...f,time,monitor,receiptPath,audit,auditPath,journalPath,records};
}
async function writeResealed(f,records,audit){
 let previous=null;for(const [sequence,record]of records.entries()){record.sequence=sequence;record.previous=previous;const {hash,...body}=record;record.hash=digest(body);previous=record.hash;}
 const journal=records.map(record=>JSON.stringify(record)).join('\n')+'\n';
 await writeFile(f.journalPath,journal);await writeFile(f.auditPath,JSON.stringify({...audit,samples:records.length,journalHead:previous,journal:identity(journal)}));
}

for(const mutations of [0,1,2])test('fresh full scans retain '+mutations+' mutations before the first successful observation',async t=>{
 const f=await fixture(t),time=clock(t),scan=traversal(f.volume,{mutations,onEnd:attempt=>time.set((attempt+1)*100)});
 const observation=await observeVolume(f.allocation,scan.sampleOptions),verified=validateEvidenceObservation(observation);
 assert.equal(observation.kind,'evidence-volume-observation-2');assert.equal(observation.maxAttempts,3);assert.equal(observation.maxWindowMs,1000);
 assert.equal(observation.attempts.length,mutations+1);assert.equal(scan.starts,mutations+1);assert.equal(observation.selectedAttempt,mutations);
 assert.equal(observation.windowStartMs,0);assert.equal(observation.windowEndMs,(mutations+1)*100);verifyAttemptChain(observation);
 for(const [index,attempt]of observation.attempts.entries()){
  assert.equal(attempt.sample.uniqueFiles,index+1);assert.equal(attempt.sample.entries,index+2);assert.equal(attempt.sample.repeatedInodes,0);
  assert.equal(attempt.sample.observedLogicalBytes,8+17*index);assert.equal(attempt.sample.completeTraversal,index===mutations);
  if(index<mutations)assert.equal(attempt.sample.failures[0].code,'EVIDENCE_MUTATION');
 }
 assert.equal(verified.failedAttempts,mutations);assert.deepEqual(verified.chosenSample,observation.attempts[mutations].sample);
 assert.equal(verified.chosenSample.startMs,mutations*100);assert.equal(verified.chosenSample.endMs,(mutations+1)*100);
 await assertClosed(scan.handles);
});

test('three full mutation attempts exhaust the fixed bound and retain every failure',async t=>{
 const f=await fixture(t),time=clock(t),scan=traversal(f.volume,{mutations:4,onEnd:attempt=>time.set((attempt+1)*100)});
 const observation=await observeVolume(f.allocation,scan.sampleOptions),verified=validateEvidenceObservation(observation);
 assert.equal(scan.starts,3);assert.equal(observation.attempts.length,3);assert.equal(observation.selectedAttempt,null);assert.equal(verified.chosenSample,null);
 assert.equal(verified.failedAttempts,3);assert(observation.attempts.every(row=>!row.sample.completeTraversal&&row.sample.failures[0].code==='EVIDENCE_MUTATION'));
 assert.equal(observation.attempts[2].sample.observedLogicalBytes,42);verifyAttemptChain(observation);await assertClosed(scan.handles);
});

for(const kind of ['permission','symlink','bound'])test(kind+' failure never retries or becomes a successful observation',async t=>{
 const f=await fixture(t);clock(t);const scan=traversal(f.volume);let options=scan.sampleOptions,expected;
 if(kind==='permission'){expected='EACCES';const original=options.statEntry;options={...options,async statEntry(path,...args){if(path===join(f.volume,'seed.bin'))throw Object.assign(Error('permission denied'),{code:'EACCES'});return original(path,...args);}};}
 if(kind==='symlink'){expected='EVIDENCE_ENTRY';await writeFile(join(f.root,'outside'),'never followed');await symlink(join(f.root,'outside'),join(f.volume,'link'));}
 if(kind==='bound'){expected='EVIDENCE_BOUND';options={...options,maxEntries:1};}
 const observation=await observeVolume(f.allocation,options),verified=validateEvidenceObservation(observation);
 assert.equal(scan.starts,1);assert.equal(observation.attempts.length,1);assert.equal(observation.selectedAttempt,null);assert.equal(verified.chosenSample,null);
 assert.equal(observation.attempts[0].sample.failures[0].code,expected);assert.equal(verified.failedAttempts,1);await assertClosed(scan.handles);
});

for(const elapsed of [1000,1001])test('a complete scan finishing at '+elapsed+'ms preserves the fixed observation deadline',async t=>{
 const f=await fixture(t),time=clock(t),scan=traversal(f.volume,{onEnd:()=>time.set(elapsed)});
 const observation=await observeVolume(f.allocation,scan.sampleOptions),verified=validateEvidenceObservation(observation);
 assert.equal(scan.starts,1);assert.equal(observation.attempts.length,1);assert.equal(observation.attempts[0].sample.completeTraversal,true);
 assert.equal(observation.windowEndMs,elapsed);assert.equal(observation.selectedAttempt,elapsed===1000?0:null);
 assert.equal(verified.chosenSample===null,elapsed>1000);await assertClosed(scan.handles);
});

test('a mutation at the deadline retains its drained failure without launching another scan',async t=>{
 const f=await fixture(t),time=clock(t),scan=traversal(f.volume,{mutations:3,onEnd:()=>time.set(1000)});
 const observation=await observeVolume(f.allocation,scan.sampleOptions);validateEvidenceObservation(observation);
 assert.equal(scan.starts,1);assert.equal(observation.attempts.length,1);assert.equal(observation.selectedAttempt,null);assert.equal(observation.attempts[0].sample.failures[0].code,'EVIDENCE_MUTATION');await assertClosed(scan.handles);
});

test('retained v2 replay accepts an actual recovered full scan and retains its failed predecessor',async t=>{
 let scan;const f=await retain(t,{sampleOptions:(fixture,time)=>{scan=traversal(fixture.volume,{mutations:1,onEnd:attempt=>time.set((attempt+1)*10)});return scan.sampleOptions;},atFinish:20});
 assert.equal(f.audit.kind,'evidence-volume-audit-2');assert.equal(f.audit.status,'PASS');assert.equal(f.audit.unknownSamples,0);assert.equal(f.audit.failedAttempts,1);
 assert.equal(f.audit.attempts,3);assert.equal(f.records[0].observation.attempts.length,2);assert.equal(f.records[0].observation.attempts[0].sample.failures[0].code,'EVIDENCE_MUTATION');
 assert.equal(f.records[0].sample.completeTraversal,true);assert.equal((await verifyEvidenceAudit(f.monitor.reference,f.receiptPath)).status,'PASS');await assertClosed(scan.handles);
});

test('an exhausted logical observation stays unknown after a later complete scan through retained replay',async t=>{
 const f=await retain(t,{sampleOptions:(fixture,time)=>traversal(fixture.volume,{mutations:3,onEnd:attempt=>time.set((attempt+1)*10)}).sampleOptions,atFinish:30});
 assert.equal(f.records[0].observation.attempts.length,3);assert.equal(f.records[0].observation.selectedAttempt,null);assert.equal(f.records[0].alarm.level,'unknown');
 assert.equal(f.records[1].sample.completeTraversal,true);assert.equal(f.records[1].observation.selectedAttempt,0);
 assert.equal(f.audit.attempts,4);assert.equal(f.audit.failedAttempts,3);assert.equal(f.audit.unknownSamples,1);assert.equal(f.audit.coverageComplete,false);
 assert.equal(f.audit.status,'INCONCLUSIVE');assert.equal(f.audit.qualification,false);assert.equal((await verifyEvidenceAudit(f.monitor.reference,f.receiptPath)).status,'INCONCLUSIVE');
});

test('complete but over-budget scans remain retained unknown observations in offline replay',async t=>{
 const f=await retain(t,{sampleOptions:(fixture,time)=>traversal(fixture.volume,{onEnd:attempt=>time.set((attempt+1)*1001)}).sampleOptions,atFinish:1001});
 assert(f.records.every(record=>record.sample.completeTraversal&&record.observation.selectedAttempt===null&&record.alarm.level==='unknown'));
 assert.equal(f.audit.unknownSamples,2);assert.equal(f.audit.status,'INCONCLUSIVE');assert.equal(f.audit.qualification,false);
 assert.equal((await verifyEvidenceAudit(f.monitor.reference,f.receiptPath)).status,'INCONCLUSIVE');
});

test('retained retry success uses its actual 4100ms start rather than its 3500ms window start for coverage',async t=>{
 const f=await fixture(t),time=clock(t);await mkdir(f.output);let rootVisits=0;
 const sampleOptions={async statEntry(path,options){
  if(path===f.volume){rootVisits++;if(rootVisits===4){await writeFile(join(f.volume,'during-gap'),'mutation');const changed=new Date('2030-01-01T00:00:01.000Z');await utimes(f.volume,changed,changed);time.set(4100);}else if(rootVisits===6)time.set(4200);}
  return lstat(path,options);
 }};
 const monitor=await startEvidenceMonitor({allocationPath:f.allocationPath,output:f.output,campaignId:'actual-success-gap',intervalMs:2000,sampleOptions});
 const receiptPath=join(f.output,'receipt.json');await writeFile(receiptPath,JSON.stringify({receiptId:'actual-success-gap',groups:[],evidenceStorage:monitor.reference}));
 time.set(3500);const recovered=await monitor.checkpoint();assert.equal(recovered.observation.windowStartMs,3500);assert.equal(recovered.observation.attempts.length,2);
 assert.equal(recovered.observation.selectedAttempt,1);assert.equal(recovered.sample.startMs,4100);assert.equal(recovered.sample.endMs,4200);
 time.set(4300);const audit=await monitor.finish({receiptPath});assert.equal(audit.maximumGapMs,4100);assert.equal(audit.unknownSamples,0);
 assert.equal(audit.failedAttempts,1);assert.equal(audit.coverageComplete,false);assert.equal(audit.status,'INCONCLUSIVE');assert.equal(audit.qualification,false);
 await retainEvidenceAudit(monitor.reference,f.output);assert.equal((await verifyEvidenceAudit(monitor.reference,receiptPath)).status,'INCONCLUSIVE');assert.equal(time.timers.size,0);
 // Rewriting only the audit cadence must not turn this real 4100ms gap into a
 // pass under a 4200ms allowance: the original reference still declares 2000ms.
 await writeFile(join(f.output,'evidence-storage','audit.json'),JSON.stringify({...audit,intervalMs:2100,coverageComplete:true,status:'PASS',qualification:true}));
 await assert.rejects(verifyEvidenceAudit(monitor.reference,receiptPath),/Unbound/);
});

test('offline replay rejects omitted or reordered attempts and a selected failed attempt after outer resealing',async t=>{
 const f=await retain(t,{sampleOptions:(fixture,time)=>traversal(fixture.volume,{mutations:1,onEnd:attempt=>time.set((attempt+1)*10)}).sampleOptions,atFinish:20});
 for(const mutate of [observation=>{observation.attempts.shift();},observation=>{observation.attempts.reverse();},observation=>{observation.selectedAttempt=0;}]){
  const records=structuredClone(f.records),audit=structuredClone(f.audit);mutate(records[0].observation);resealAttempts(records[0].observation);
  await writeResealed(f,records,audit);await assert.rejects(verifyEvidenceAudit(f.monitor.reference,f.receiptPath));
 }
});

test('pure replay rejects rehashed nonretryable predecessors, overlapping attempts and selection drift',async t=>{
 const f=await fixture(t),time=clock(t),scan=traversal(f.volume,{mutations:1,onEnd:attempt=>time.set((attempt+1)*100)}),original=await observeVolume(f.allocation,scan.sampleOptions);
 for(const mutate of [
  value=>{value.attempts[0].sample.failures[0].code='EACCES';},
  value=>{value.attempts[1].startMs=value.attempts[0].endMs-1;},
  value=>{value.selectedAttempt=0;},
  value=>{value.selectedAttempt=null;},
  value=>{value.maxAttempts=4;},
  value=>{value.maxWindowMs=1001;},
  value=>{const prior=value.attempts.at(-1),extra=structuredClone(prior);extra.sequence=value.attempts.length;extra.startMs=prior.endMs;extra.endMs=prior.endMs;extra.sample.startMs=prior.endMs;extra.sample.endMs=prior.endMs;value.attempts.push(extra);value.selectedAttempt=extra.sequence;},
 ]){const changed=structuredClone(original);mutate(changed);resealAttempts(changed);assert.throws(()=>validateEvidenceObservation(changed));}
 await assertClosed(scan.handles);
});

test('unchanged v1 verifier replays v1-format retained evidence from actual complete scans',async t=>{
 const f=await retain(t),records=structuredClone(f.records),audit=structuredClone(f.audit);
 // Compatibility fixture only: preserve the real raw v1 scan payloads and
 // receipt/allocation identities, then emit the historical journal schema.
 for(const record of records){assert.equal(record.observation.attempts.length,1);assert.equal(record.sample.completeTraversal,true);delete record.observation;}
 audit.kind='evidence-volume-audit-1';audit.counterMode='periodic-while-campaign-active';delete audit.attempts;delete audit.failedAttempts;delete audit.observationPolicy;
 let lastStart=audit.startedMonotonicMs;let maximumGapMs=0;for(const record of records){maximumGapMs=Math.max(maximumGapMs,record.sample.startMs-lastStart);lastStart=record.sample.startMs;}
 audit.maximumGapMs=maximumGapMs;await writeResealed(f,records,audit);
 assert.equal((await verifyEvidenceAudit(f.monitor.reference,f.receiptPath)).status,'PASS');
});

// The seams below still enumerate native Dir handles and mutate real private
// fixture paths. They control when a native ENOENT becomes observable; they do
// not fabricate a successful sample or make a timing/qualification claim.
function descendantRace(f,{target=join(f.volume,'seed.bin'),phase='stat-before',mutate=path=>rm(path,{recursive:true}),onFailure=()=>{}}={}){
 let fired=false,starts=0,targetStats=0;const handles=[],enumerated=new Set();
 const trigger=async()=>{assert(enumerated.has(target),'the disappearing child was actually enumerated');fired=true;await mutate(target);};
 return {handles,get starts(){return starts;},get fired(){return fired;},sampleOptions:{
  async statEntry(path,options){
   if(path===target){
    targetStats++;
    if(!fired&&(phase==='stat-before'&&targetStats===1||phase==='stat-after'&&targetStats===2))await trigger();
   }
   try{return await lstat(path,options);}catch(error){if(path===target)onFailure(error);throw error;}
  },
  async openDirectory(path){
   if(path===f.volume){await assertClosed(handles);starts++;}
   if(path===target&&!fired&&phase==='open-directory')await trigger();
   const handle=await opendir(path);handles.push(handle);
   return {async *[Symbol.asyncIterator](){
    for await(const entry of handle){
     enumerated.add(join(path,entry.name));
     if(path===target&&!fired&&phase==='read-directory'){
      await trigger();
      // A native iterator need not report an unlinked directory on every OS.
      // Expose the actual missing path error while that native iterator is
      // active; abrupt generator completion must still close its Dir handle.
      await lstat(path,{bigint:true});
     }
     yield entry;
    }
   }};
  }
 }};
}
function descendantFailure(observation,{phase,member,code='EVIDENCE_MUTATION',original='ENOENT'}){
 const sample=observation.attempts[0].sample;
 assert.equal(sample.completeTraversal,false);assert.equal(sample.failures.length,1);
 assert.deepEqual(sample.failures[0],{code,message:'Evidence observation unavailable; phase='+phase+'; code='+original+'; member='+member});
 assert.deepEqual(Object.keys(sample.failures[0]).sort(),['code','message']);
 assert.equal(observation.maxAttempts,3);assert.equal(observation.maxWindowMs,1000);verifyAttemptChain(observation);
 return sample.failures[0];
}

for(const [kind,phase]of [['file','stat-before'],['directory','stat-before'],['directory','open-directory'],['directory','read-directory'],['file','stat-after'],['directory','stat-after']])test('an enumerated '+kind+' disappearing during '+phase+' retains failure before a fresh complete scan',async t=>{
 const f=await fixture(t);clock(t);const target=join(f.volume,'vanishing');
 if(kind==='file')await writeFile(target,Buffer.alloc(19,3));
 else{await mkdir(target);if(phase==='read-directory')await writeFile(join(target,'child.bin'),Buffer.alloc(23,4));}
 const scan=descendantRace(f,{target,phase}),observation=await observeVolume(f.allocation,scan.sampleOptions),verified=validateEvidenceObservation(observation);
 assert.equal(scan.fired,true);assert.equal(scan.starts,2);assert.equal(observation.attempts.length,2);assert.equal(observation.selectedAttempt,1);
 descendantFailure(observation,{phase,member:'vanishing'});assert.equal(verified.failedAttempts,1);
 assert.equal(verified.chosenSample.completeTraversal,true);assert.equal(verified.chosenSample.entries,2);assert.equal(verified.chosenSample.uniqueFiles,1);
 assert.equal(verified.chosenSample.observedLogicalBytes,8);await assertClosed(scan.handles);
});

test('a disappearing subtree is retried only after its surviving allocation ancestor is verified',async t=>{
 const f=await fixture(t);clock(t);const branch=join(f.volume,'branch'),target=join(branch,'leaf');await mkdir(branch);await writeFile(target,'leaf');
 const scan=descendantRace(f,{target,mutate:()=>rm(branch,{recursive:true})}),observation=await observeVolume(f.allocation,scan.sampleOptions);
 descendantFailure(observation,{phase:'stat-before',member:'branch/leaf'});
 assert.equal(scan.starts,2);assert.equal(observation.selectedAttempt,1);assert.equal(validateEvidenceObservation(observation).chosenSample.observedLogicalBytes,8);await assertClosed(scan.handles);
});

for(const kind of ['removed','replaced','symlinked'])test('a '+kind+' allocation root cannot turn a missing descendant into a retry',async t=>{
 const f=await fixture(t);clock(t);const former=join(f.root,'former-volume'),outside=join(f.root,'outside');await mkdir(outside);
 const scan=descendantRace(f,{mutate:async()=>{
  if(kind==='removed')await rm(f.volume,{recursive:true});
  else{await rename(f.volume,former);if(kind==='replaced')await mkdir(f.volume,{mode:0o700});else await symlink(outside,f.volume);}
 }}),observation=await observeVolume(f.allocation,scan.sampleOptions),verified=validateEvidenceObservation(observation);
 assert.equal(scan.fired,true);assert.equal(scan.starts,1);assert.equal(observation.attempts.length,1);assert.equal(observation.selectedAttempt,null);assert.equal(verified.chosenSample,null);
 const failure=observation.attempts[0].sample.failures[0];assert.notEqual(failure.code,'EVIDENCE_MUTATION');
 assert.equal(failure.message,'Evidence observation unavailable; phase=verify-root; code='+(kind==='removed'?'ENOENT':'EVIDENCE_IO')+'; member=.');
 // In particular, root verification's own ENOENT must not be caught again by
 // the parent's read-directory catch and reclassified as a child mutation.
 verifyAttemptChain(observation);await assertClosed(scan.handles);
});

for(const kind of ['replaced','symlinked','regular-file'])test('a '+kind+' surviving ancestor remains a nonretryable missing-child failure',async t=>{
 const f=await fixture(t);clock(t);const branch=join(f.volume,'branch'),target=join(branch,'leaf'),former=join(f.root,'former-branch'),outside=join(f.root,'outside');
 await mkdir(branch);await mkdir(outside);await writeFile(target,'leaf');
 const scan=descendantRace(f,{target,mutate:async()=>{
  await rename(branch,former);
  if(kind==='replaced')await mkdir(branch);else if(kind==='symlinked')await symlink(outside,branch);else await writeFile(branch,'not a directory');
 }}),observation=await observeVolume(f.allocation,scan.sampleOptions);
 assert.equal(scan.fired,true);assert.equal(scan.starts,1);assert.equal(observation.attempts.length,1);assert.equal(observation.selectedAttempt,null);
 assert.equal(validateEvidenceObservation(observation).chosenSample,null);
 if(kind==='regular-file')descendantFailure(observation,{phase:'stat-before',member:'branch/leaf',code:'ENOTDIR',original:'ENOTDIR'});
 else descendantFailure(observation,{phase:'verify-member',member:'branch',code:kind==='replaced'?'EVIDENCE_IDENTITY':'EVIDENCE_ENTRY',original:kind==='replaced'?'EVIDENCE_IDENTITY':'EVIDENCE_ENTRY'});
 await assertClosed(scan.handles);
});

test('a descendant recreated with a new identity before missing-path verification is not admitted as a disappearance',async t=>{
 const f=await fixture(t);clock(t);const target=join(f.volume,'vanishing'),former=join(f.root,'former-member');await mkdir(target);
 const scan=descendantRace(f,{target,phase:'open-directory',mutate:async()=>{
  await rename(target,former);await mkdir(target);
  // The native missing-path result arrives after a replacement has appeared.
  await lstat(join(target,'already-removed'),{bigint:true});
 }}),observation=await observeVolume(f.allocation,scan.sampleOptions);
 descendantFailure(observation,{phase:'verify-member',member:'vanishing',code:'EVIDENCE_IDENTITY',original:'EVIDENCE_IDENTITY'});
 assert.equal(scan.starts,1);assert.equal(observation.attempts.length,1);assert.equal(observation.selectedAttempt,null);assert.equal(validateEvidenceObservation(observation).chosenSample,null);await assertClosed(scan.handles);
});

test('a native root replacement witnessed by post-stat is a hard failure without a fresh scan',async t=>{
 const f=await fixture(t);clock(t);let rootStats=0,starts=0;const handles=[],former=join(f.root,'former-volume');
 const observation=await observeVolume(f.allocation,{
  async openDirectory(path){if(path===f.volume)starts++;const handle=await opendir(path);handles.push(handle);return handle;},
  async statEntry(path,options){
   if(path===f.volume&&++rootStats===2){await assertClosed(handles);await rename(f.volume,former);await mkdir(f.volume,{mode:0o700});}
   return lstat(path,options);
  }
 });
 descendantFailure(observation,{phase:'identity',member:'.',code:'EVIDENCE_ROOT',original:'EVIDENCE_ROOT'});
 assert.equal(rootStats,2);assert.equal(starts,1);assert.equal(observation.attempts.length,1);assert.equal(observation.selectedAttempt,null);assert.equal(validateEvidenceObservation(observation).chosenSample,null);await assertClosed(handles);
});

test('a native target symlink replacement witnessed by post-stat never becomes a retryable identity mutation',async t=>{
 const f=await fixture(t);clock(t);const target=join(f.volume,'seed.bin'),former=join(f.root,'former-seed'),outside=join(f.root,'outside');await writeFile(outside,'not followed');
 const scan=descendantRace(f,{target,phase:'stat-after',mutate:async()=>{await rename(target,former);await symlink(outside,target);}}),observation=await observeVolume(f.allocation,scan.sampleOptions);
 descendantFailure(observation,{phase:'identity',member:'seed.bin',code:'EVIDENCE_ENTRY',original:'EVIDENCE_ENTRY'});
 assert.equal(scan.fired,true);assert.equal(scan.starts,1);assert.equal(observation.attempts.length,1);assert.equal(observation.selectedAttempt,null);assert.equal(validateEvidenceObservation(observation).chosenSample,null);await assertClosed(scan.handles);
});

for(const [phase,code]of [['stat-before','EIO'],['open-directory','EACCES'],['read-directory','EIO'],['stat-after','EACCES']])test(code+' during descendant '+phase+' retains its own failure and never retries',async t=>{
 const f=await fixture(t);clock(t);const target=join(f.volume,'restricted');await mkdir(target);await writeFile(join(target,'child'),'child');
 const scan=descendantRace(f,{target,phase,mutate:async()=>{throw Object.assign(Error('private message '+f.root),{code,path:f.root});}}),observation=await observeVolume(f.allocation,scan.sampleOptions);
 descendantFailure(observation,{phase,member:'restricted',code,original:code});
 assert.equal(scan.starts,1);assert.equal(observation.attempts.length,1);assert.equal(observation.selectedAttempt,null);assert.equal(validateEvidenceObservation(observation).chosenSample,null);
 assert(!observation.attempts[0].sample.failures[0].message.includes(f.root));await assertClosed(scan.handles);
});

test('descendant diagnostics bound and sanitize the actual enumerated member without exposing absolute or error-supplied paths',async t=>{
 const f=await fixture(t);clock(t);const name='member\\with\ncontrol"'+ 'x'.repeat(180),target=join(f.volume,name);await writeFile(target,'private');
 const scan=descendantRace(f,{target}),observation=await observeVolume(f.allocation,scan.sampleOptions);
 const member=name.replace(/[^\x20-\x7e]|[\\"]/g,'?').slice(0,160),failure=descendantFailure(observation,{phase:'stat-before',member});
 assert.equal(member.length,160);assert(!failure.message.includes(f.root));assert(!/[\x00-\x1f\x7f\\"]/.test(failure.message));
 assert.equal(scan.starts,2);assert.equal(observation.selectedAttempt,1);assert.equal(validateEvidenceObservation(observation).failedAttempts,1);await assertClosed(scan.handles);
});

for(const elapsed of [999,1000])test('a vanished-child failure at '+elapsed+'ms obeys the existing fixed retry window',async t=>{
 const f=await fixture(t),time=clock(t),scan=descendantRace(f,{onFailure:()=>time.set(elapsed)}),observation=await observeVolume(f.allocation,scan.sampleOptions);
 descendantFailure(observation,{phase:'stat-before',member:'seed.bin'});
 assert.equal(observation.windowEndMs,elapsed);assert.equal(scan.starts,elapsed===999?2:1);assert.equal(observation.attempts.length,elapsed===999?2:1);
 assert.equal(observation.selectedAttempt,elapsed===999?1:null);assert.equal(validateEvidenceObservation(observation).chosenSample===null,elapsed===1000);await assertClosed(scan.handles);
});

for(const siblingFailure of [false,true])test('a missing descendant drains every original branch '+(siblingFailure?'and a held hard failure prevents retry':'before launching its retry'),async t=>{
 const f=await fixture(t);clock(t);const held=join(f.volume,'a-held'),member=join(held,'pending'),victim=join(f.volume,'z-vanishing');
 await mkdir(held);await writeFile(member,'held');await writeFile(victim,'vanishing');
 let enter,release,missing;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;}),missingObserved=new Promise(resolve=>{missing=resolve;});
 let starts=0,heldFinished=false,settled=false,fired=false;const handles=[];
 const options={
  async openDirectory(path){
   if(path===f.volume){await assertClosed(handles);starts++;if(starts>1)assert.equal(heldFinished,true,'the original branch settled before the fresh scan');}
   const handle=await opendir(path);handles.push(handle);
   return {async *[Symbol.asyncIterator](){
    if(path===f.volume){
     // Only this tiny fixture orders already-read native entries, so sibling
     // branch issuance does not depend on directory enumeration order.
     const entries=[];for await(const entry of handle)entries.push(entry);entries.sort((a,b)=>a.name.localeCompare(b.name));
     for(const entry of entries)yield entry;
    }else for await(const entry of handle)yield entry;
   }};
  },
  async statEntry(path,options){
   if(path===member&&starts===1){
    enter();await gate;heldFinished=true;
    if(siblingFailure)throw Object.assign(Error('held permission refusal'),{code:'EACCES'});
   }
   if(path===victim&&!fired){fired=true;await entered;await rm(victim);try{return await lstat(path,options);}catch(error){missing();throw error;}}
   return lstat(path,options);
  }
 };
 const pending=observeVolume(f.allocation,options);pending.then(()=>{settled=true;},()=>{settled=true;});
 try{
  await Promise.race([missingObserved,pending.then(()=>{throw Error('the controlled missing descendant was never observed');})]);
  assert.equal(starts,1);assert.equal(settled,false);assert.equal(heldFinished,false);
  release();const observation=await pending,verified=validateEvidenceObservation(observation);
  assert.equal(heldFinished,true);
  if(siblingFailure){
   assert.equal(starts,1);assert.equal(observation.attempts.length,1);assert.equal(observation.selectedAttempt,null);assert.equal(verified.chosenSample,null);
   descendantFailure(observation,{phase:'stat-before',member:'a-held/pending',code:'EACCES',original:'EACCES'});
  }else{
   assert.equal(starts,2);assert.equal(observation.attempts.length,2);assert.equal(observation.selectedAttempt,1);
   descendantFailure(observation,{phase:'stat-before',member:'z-vanishing'});assert.equal(verified.chosenSample.observedLogicalBytes,12);
  }
  await assertClosed(handles);
 }finally{release();await pending;await assertClosed(handles);}
});

test('retained replay preserves a real vanished-child attempt and accepts only the drained fresh full scan',async t=>{
 let scan;const f=await retain(t,{sampleOptions:fixture=>{scan=descendantRace(fixture);return scan.sampleOptions;}});
 const observation=f.records[0].observation;descendantFailure(observation,{phase:'stat-before',member:'seed.bin'});
 assert.equal(observation.attempts.length,2);assert.equal(observation.selectedAttempt,1);assert.equal(f.audit.failedAttempts,1);assert.equal(f.audit.attempts,3);
 assert.equal(f.audit.unknownSamples,0);assert.equal(f.audit.status,'PASS');assert.equal((await verifyEvidenceAudit(f.monitor.reference,f.receiptPath)).status,'PASS');await assertClosed(scan.handles);
 const records=structuredClone(f.records),audit=structuredClone(f.audit);records[0].observation.attempts[0].sample.failures[0].code='ENOENT';resealAttempts(records[0].observation);
 await writeResealed(f,records,audit);await assert.rejects(verifyEvidenceAudit(f.monitor.reference,f.receiptPath));
});

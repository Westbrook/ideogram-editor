// Source-only authored fixtures. Uses real model/reader/ledger dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import {allocationsURL,modelMemoryURL,uiModelOwnerURL,uiModule,readOwnedJSON} from '../ui-model-module.mjs';
const root=process.env.REQUEST_NAVIGATION_ROOT??'.';
const {allocationLedger,ALLOCATION_LIMITS}=await import(allocationsURL),{cloneOwnedModel}=await import(modelMemoryURL);
const {RequestNavigationMemory,navigationHistory,BoundedAnnouncementMap,REQUEST_NAVIGATION_LIMITS:L}=await import(await uiModule(root+'/src/ui/request-navigation-memory.ts',{'../observability/model-memory.js':modelMemoryURL,'./model-owner.js':uiModelOwnerURL}));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const totals=()=>{const s=allocationLedger.snapshot();return {cpu:s.cpuBytes,handles:s.handles,records:s.activeRecords};};
function fixture(){let transport=async()=>new Response('{}',{headers:{'content-length':'2'}});const host={updateComplete:Promise.resolve(true),requestUpdate(){}};const editor={ownedJSON(path,owner,init,owns,maxBytes,kind){return readOwnedJSON((path,init)=>transport(path,init),path,{owner,init,owns,maxBytes,kind});}};return {host,memory:new RequestNavigationMemory(host,editor),transport(next){transport=next;}};}
test('candidate replacement retains literal template data until the actual host commit barrier',async()=>{
 const before=totals(),f=fixture(),commit=deferred(),first=cloneOwnedModel('navigation-test',{caption:'old'}),next=cloneOwnedModel('navigation-test',{caption:'new'});f.memory.adoptCandidate('attempt',first);f.host.updateComplete=commit.promise;f.memory.adoptCandidate('attempt',next);await turn();const pin=first.pin();pin();assert.equal(f.memory.lifecycle.candidatePages,1);commit.resolve(true);await turn();assert.throws(()=>first.pin(),/MODEL_MEMORY_RELEASED/);await f.memory.release();assert.deepEqual(totals(),before);
});
test('candidate aggregate admission refuses a replacement without altering its complete previous page',async()=>{
 const before=totals(),f=fixture(),first=cloneOwnedModel('navigation-test',{caption:'previous'});f.memory.adoptCandidate('attempt',first);const previous=f.memory.lifecycle.candidateBytes,refused=cloneOwnedModel('navigation-test',{caption:'x'.repeat(L.pageBytes/2)});
 try{assert.throws(()=>f.memory.adoptCandidate('attempt',refused),/REQUEST_RESULT_PAGE_LIMIT/);assert.equal(f.memory.lifecycle.candidateBytes,previous);assert.equal(f.memory.lifecycle.candidatePages,1);const pin=first.pin();pin();}finally{refused.release();await f.memory.release();}assert.deepEqual(totals(),before);
});
test('action acquires all owners synchronously before replacement can retire a captured candidate',async()=>{
 const before=totals(),f=fixture(),old=cloneOwnedModel('navigation-test',{caption:'captured old'}),gate=deferred(),entered=deferred();f.memory.adoptCandidate('attempt',old);const work=f.memory.run(async()=>{entered.resolve();await gate.promise;});const next=cloneOwnedModel('navigation-test',{caption:'new'});f.memory.adoptCandidate('attempt',next);await entered.promise;await turn();const pin=old.pin();pin();let released=false;const drain=f.memory.release().then(()=>{released=true;});await turn();assert.equal(released,false);gate.resolve();await Promise.all([work,drain]);assert.throws(()=>old.pin(),/MODEL_MEMORY_RELEASED/);assert.deepEqual(totals(),before);
});
test('release aborts and drains actual native response cancellation plus its consuming action',async()=>{
 const before=totals(),f=fixture(),started=deferred(),cancelled=deferred(),gate=deferred();let finished=false;
 f.transport(async()=>new Response(new ReadableStream({pull(){started.resolve();},cancel(){cancelled.resolve();return gate.promise;}}),{headers:{'content-length':'100'}}));
 const work=f.memory.run(async()=>{const model=await f.memory.candidates.read('/pending',()=>true);model.release();}),rejected=assert.rejects(work,{name:'AbortError'});await started.promise;const release=f.memory.release().then(()=>{finished=true;});await cancelled.promise;await turn();assert.equal(finished,false);assert(totals().cpu>before.cpu);gate.resolve();await Promise.all([release,rejected]);assert.deepEqual(totals(),before);
});
test('failed render cleanup keeps reachable owners until successful retry',async()=>{
 const before=totals(),f=fixture(),failure=Error('render failed'),failedCommit=Promise.reject(failure);let fail=true;
 // All four owners share this one failed host commit. Creating a new rejected
 // promise for every request would invent unobserved renders for empty owners.
 f.host.requestUpdate=function(){this.updateComplete=fail?failedCommit:Promise.resolve(true);};
 f.memory.adoptCandidate('attempt',cloneOwnedModel('navigation-test',{caption:'retained after native error'}));
 try{await assert.rejects(f.memory.release(),error=>{assert(error instanceof AggregateError);assert.match(error.message,/REQUEST_NAVIGATION_RELEASE_INCOMPLETE/);assert.equal(error.errors.length,1);const cleanup=error.errors[0];assert(cleanup instanceof AggregateError);assert.equal(cleanup.message,'UI_MODEL_RELEASE_INCOMPLETE');assert.equal(cleanup.errors.length,1);assert.equal(cleanup.errors[0],failure);return true;});
 assert(totals().cpu>before.cpu);assert.equal(f.memory.lifecycle.candidates.cleanupFailures,1);}finally{fail=false;await f.memory.release();}assert.deepEqual(totals(),before);
});
test('cursor history refusal preserves all caller entries, admits before copy, and never trims a prefix',()=>{
 const before=totals(),prior=['first','second'];assert.throws(()=>navigationHistory(Array(L.history).fill('cursor'),'next'),/REQUEST_NAVIGATION_HISTORY_LIMIT/);assert.throws(()=>navigationHistory(['x'.repeat(L.historyBytes/2)],'next'),/REQUEST_NAVIGATION_HISTORY_LIMIT/);assert.deepEqual(prior,['first','second']);const pressure=allocationLedger.reserve({owner:'navigation-test-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-allocationLedger.snapshot().cpuBytes});try{assert.throws(()=>navigationHistory(prior,'next'),/ALLOCATION_BUDGET/);}finally{pressure.release();}const accepted=navigationHistory(prior,'next',1);assert.deepEqual(accepted.value,['first','next']);accepted.release();assert.deepEqual(totals(),before);
});
test('announcement replacement admission preserves prior exact text and releases on delete/clear',()=>{
 const before=totals(),map=new BoundedAnnouncementMap();map.set('one','retained');const pressure=allocationLedger.reserve({owner:'navigation-test-pressure',kind:'control',cpuBytes:ALLOCATION_LIMITS.cpuBytes-ALLOCATION_LIMITS.textPartitionBytes-allocationLedger.snapshot().cpuBytes});try{assert.throws(()=>map.set('one','longer replacement'),/ALLOCATION_BUDGET/);assert.equal(map.get('one'),'retained');}finally{pressure.release();}assert.throws(()=>map.set('two','x'.repeat(L.announcementBytes/2)),/REQUEST_ANNOUNCEMENT_LIMIT/);assert.equal(map.size,1);map.set('two','ok');assert(map.delete('one'));map.clear();assert.deepEqual(totals(),before);
});
test('repair Files count their native handles and bounded metadata, not logical backing bytes',async()=>{
 const before=totals(),f=fixture(),file=new File(['bytes'],'original.bin');f.memory.adoptFile('candidate',file);assert.equal(f.memory.lifecycle.files.models,1);const metadata=f.memory.lifecycle.fileBytes;assert(metadata>0);assert.throws(()=>f.memory.adoptFile('candidate',new File(['x'],'n'.repeat(L.fileMetadataBytes))),/REQUEST_REPAIR_METADATA_LIMIT/);assert.equal(f.memory.lifecycle.fileBytes,metadata);assert.equal(f.memory.lifecycle.files.models,1);await f.memory.release();assert.deepEqual(totals(),before);
});

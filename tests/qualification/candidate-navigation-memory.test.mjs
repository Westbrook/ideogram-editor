// Source-only tests. The root coordinator runs these against the assembled tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import {allocationsURL,modelMemoryURL,uiModelOwnerURL,uiModule,readOwnedJSON} from './module.mjs';
const root=process.env.CANDIDATE_COMPARISON_ROOT??'.';
const {allocationLedger}=await import(allocationsURL),{cloneOwnedModel}=await import(modelMemoryURL);
const {RequestNavigationMemory}=await import(await uiModule(root+'/src/ui/request-navigation-memory.ts',{'../observability/model-memory.js':modelMemoryURL,'./model-owner.js':uiModelOwnerURL}));
const totals=()=>{const s=allocationLedger.snapshot();return {cpu:s.cpuBytes,handles:s.handles,records:s.activeRecords};};
const fixture=()=>new RequestNavigationMemory({updateComplete:Promise.resolve(true),requestUpdate(){}},{ownedJSON(path,owner,init,owns,maxBytes,kind){return readOwnedJSON(async()=>new Response('{}',{headers:{'content-length':'2'}}),path,{owner,init,owns,maxBytes,kind});}});
const row=()=>cloneOwnedModel('candidate-cursor-test',{items:[]});
test('prospective page and cursor remain unpublished until both parent and child admission succeed',async()=>{
 const before=totals(),memory=fixture(),first=row();memory.adoptCandidate('attempt',first);const bytes=memory.lifecycle.candidateBytes,next=row(),token=memory.prepareCandidate('attempt',next,{cursor:'next-token',back:[],last:''});
 assert.deepEqual(memory.candidatePage('attempt'),{cursor:'',back:[]});assert.equal(memory.lifecycle.candidateBytes,bytes);
 // Simulate child index refusing admission: it must never require parent rollback.
 token.release();next.release();assert.deepEqual(memory.candidatePage('attempt'),{cursor:'',back:[]});assert.equal(memory.lifecycle.candidateBytes,bytes);await memory.release();assert.deepEqual(totals(),before);
});
test('committed forward/back history is exact and poll replacement keeps the current page',async()=>{
 const before=totals(),memory=fixture();memory.adoptCandidate('attempt',row());let t=memory.prepareCandidate('attempt',row(),{cursor:'second',back:[],last:''});t.commit();t.release();t=memory.prepareCandidate('attempt',row());t.commit();t.release();assert.deepEqual(memory.candidatePage('attempt'),{cursor:'second',back:['']});
 const prior=memory.candidatePage('attempt');t=memory.prepareCandidate('attempt',row(),{cursor:prior.back.at(-1),back:prior.back,take:0});t.commit();t.release();assert.deepEqual(memory.candidatePage('attempt'),{cursor:'',back:[]});await memory.release();assert.deepEqual(totals(),before);
});
test('oversized cursor/history admission preserves exact prior page and caller ownership',async()=>{
 const before=totals(),memory=fixture();memory.adoptCandidate('attempt',row());for(const proposal of [{cursor:'x'.repeat(16385),back:[]},{cursor:'valid',back:Array(1024).fill(''),last:'x'},{cursor:'valid',back:['x'.repeat(32768)]}]){const model=row();assert.throws(()=>memory.prepareCandidate('attempt',model,proposal),/REQUEST_NAVIGATION_HISTORY_LIMIT/);const pin=model.pin();pin();model.release();assert.deepEqual(memory.candidatePage('attempt'),{cursor:'',back:[]});}await memory.release();assert.deepEqual(totals(),before);
});
test('intervening page publication invalidates a prepared token before it can replace state',async()=>{
 const before=totals(),memory=fixture(),candidate=row(),pending=memory.prepareCandidate('attempt',candidate,{cursor:'stale',back:[]});memory.adoptCandidate('other',row());assert.throws(()=>pending.commit(),/REQUEST_RESULT_PAGE_CHANGED/);pending.release();candidate.release();assert.equal(memory.candidatePage('attempt'),undefined);await memory.release();assert.deepEqual(totals(),before);
});
test('latest per-attempt read wins while old native read remains counted until actual close',async()=>{
 const before=totals(),memory=fixture(),a=memory.beginCandidateRead('attempt'),b=memory.beginCandidateRead('attempt');assert.equal(a.current(),false);assert.equal(b.current(),true);assert.equal(memory.lifecycle.candidateReads,2);a.close();assert.equal(memory.candidatePending('attempt'),true);memory.clearCandidate('attempt');assert.equal(b.current(),false);assert.equal(memory.lifecycle.candidateReads,1);b.close();await memory.release();assert.deepEqual(totals(),before);
});
test('actual outstanding reads are bounded even when every new read supersedes the same attempt',async()=>{
 const before=totals(),memory=fixture(),reads=[];for(let i=0;i<8;i++)reads.push(memory.beginCandidateRead('attempt'));assert.throws(()=>memory.beginCandidateRead('attempt'),/REQUEST_CANDIDATE_READ_LIMIT/);assert.equal(memory.lifecycle.candidateReads,8);for(const read of reads)read.close();await memory.release();assert.deepEqual(totals(),before);
});

test('navigation progress belongs only to its exact current read while every retired read stays charged',async()=>{
 const before=totals(),memory=fixture(),poll=memory.beginCandidateRead('attempt');
 assert.equal(memory.candidatePending('attempt'),true);assert.equal(memory.candidateNavigating('attempt'),false);
 const next=memory.beginCandidateRead('attempt',true);assert.equal(poll.current(),false);assert.equal(memory.candidateNavigating('attempt'),true);
 poll.close();assert.equal(memory.lifecycle.candidateReads,1);assert.equal(memory.candidateNavigating('attempt'),true,'Older poll cleanup cannot clear the active navigation');
 const newer=memory.beginCandidateRead('attempt',true);next.close();assert.equal(memory.candidateNavigating('attempt'),true,'Older navigation cleanup cannot clear its successor');
 memory.clearCandidate('attempt');assert.equal(newer.current(),false);assert.equal(memory.candidatePending('attempt'),false);assert.equal(memory.candidateNavigating('attempt'),false);assert.equal(memory.lifecycle.candidateReads,1,'Invalidation is not physical read completion');
 const current=memory.beginCandidateRead('attempt');newer.close();assert.equal(current.current(),true);assert.equal(memory.candidatePending('attempt'),true);assert.equal(memory.candidateNavigating('attempt'),false);
 current.close();await memory.release();assert.deepEqual(totals(),before);
});

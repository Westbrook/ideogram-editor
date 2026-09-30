import test from 'node:test';
import assert from 'node:assert/strict';
import {initialized,pending} from './initialization-helpers.mjs';
test('recovered known attempt has a truthful public pending view before its first observation',{timeout:20000},async t=>{
 const x=await initialized(t),job=await x.current(),before=await x.audit();
 assert.equal(job.attempts[0].state,'acknowledged');assert.equal(job.attempts[0].recoveryRequired,false);assert.equal(before.candidateJobs,0);assert.equal(before.candidateJournal,0);assert.equal(before.steps,0);assert.equal(before.effects.filter(e=>e.method==='POST').length,1);
 const response=await x.read(x.path);t.diagnostic(JSON.stringify({status:response.status,body:response.json,jobId:job.id,attemptId:job.attempts[0].id,epoch:before.epoch}));
 assert.deepEqual(await x.audit(),before);pending(response,job);
});

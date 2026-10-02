import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,recover,cancel,until,turn} from './queue-controls.mjs';
async function settled(f){await until(()=>f.render().busy==='false');}
async function refresh(f){const before=f.updates();f.click('Refresh durable queue');await until(()=>f.updates()>before);await turn();}
test('settled recovery permits one fresh current-version cancellation and F3 before acknowledgement',async t=>{
 const f=await fixture(t);await f.heldRecovery();await f.refreshedRecovery();assert.equal(f.button(cancel).disabled,true);f.recovery.resolve();await settled(f);
 f.click(cancel);await until(()=>f.commands.some(c=>c.type==='CancelJob'));assert.equal(f.render().busy,'true');assert.match(f.render().text,/Saving cancellation request…/);assert.deepEqual(f.commands,[{type:'RecoverJob',jobId:'job',attemptId:'attempt',expectedVersion:'5'},{type:'CancelJob',jobId:'job',attemptId:'attempt',expectedVersion:'6'}]);
 f.cancellation.resolve();await settled(f);assert.equal(f.commands.filter(c=>c.type==='CancelJob').length,1);assert.ok(!f.commands.some(c=>c.type==='QueueInference'));
});
test('all affected command siblings advertise busy availability including retained candidate actions',async t=>{
 const f=await fixture(t);f.setCandidates({requestedCount:1,actualCount:1,items:[{id:'candidate',version:'2',outputIndex:0,state:'transfer-failed',safety:'safe',hidden:false}],repair:{candidate:{hash:'sha256:'+'1'.repeat(64),byteLength:'3',mediaType:'image/png'}}});f.click('Inspect retained results');await until(()=>f.render().buttons.some(b=>b.name==='Hide output 1'));await f.heldRecovery();
 for(const name of [recover,cancel,'Undo pending request','Hide output 1','Recover exact original for output 1','Retry retrieval or preparation for output 1','Set request cap','Disable request cap'])assert.equal(f.button(name).disabled,true,name);
 assert.equal(f.render().busy,'true');f.recovery.resolve();await settled(f);assert.equal(f.button(cancel).disabled,false);
});
test('rejected recovery visibly settles without automatic cancellation',async t=>{
 const f=await fixture(t);await f.heldRecovery();f.recovery.reject(Error('fixture recovery failure'));await settled(f);await turn();assert.match(f.render().errors.join(' '),/fixture recovery failure/);assert.deepEqual(f.commands.map(c=>c.type),['RecoverJob']);assert.equal(f.button(cancel).disabled,false);
});
test('unresolved recovery remains unavailable after refreshed queue state',async t=>{
 const f=await fixture(t);await f.heldRecovery();await f.refreshedRecovery();await turn();assert.equal(f.render().busy,'true');assert.equal(f.button(cancel).disabled,true);assert.equal(f.commands.length,1);f.recovery.resolve();await settled(f);
});
test('duplicate recovery callbacks issue one held command',async t=>{
 const f=await fixture(t),b=f.button(recover);b.click(f.event());b.click(f.event());await until(()=>f.commands.length===1);await turn();assert.equal(f.commands.length,1);f.recovery.resolve();await settled(f);assert.equal(f.commands.length,1);
});
test('a stale busy click is never replayed after recovery settles',async t=>{
 const f=await fixture(t),old=f.button(cancel);await f.heldRecovery();old.click(f.event());await turn();assert.equal(f.commands.length,1);f.recovery.resolve();await settled(f);await turn();assert.deepEqual(f.commands.map(c=>c.type),['RecoverJob']);
});
for(const boundary of ['identity','owner','document','revision','veto','dispose','generation'])test('cancellation callback preserves '+boundary+' fence',async t=>{
 const f=await fixture(t),b=f.button(cancel),e=f.event();b.click(e);
 if(boundary==='identity')f.setIdentity('replacement');if(boundary==='owner')f.editor.draftOwner={drafts:new Map()};if(boundary==='document')f.editor.view.document={id:'other',revision:'1'};if(boundary==='revision')f.editor.view.document.revision='2';if(boundary==='veto')e.defaultPrevented=true;if(boundary==='dispose')f.flow.dispose();if(boundary==='generation')f.flow.operationChanged('Generate with Fast');await turn();assert.equal(f.commands.length,0);
});
test('a superseded public risk acknowledgement cannot authorize the newer selection',async t=>{
 const f=await fixture(t),q=f.getQueue();q.jobs[0].attempts[0].state='submission-uncertain';f.setQueue(q);await refresh(f);f.click('Review possible overlapping work');await turn();const old=f.button('Acknowledge risk and release this local hold');
 q.jobs[0].version='7';f.setQueue(q);await refresh(f);f.click('Review possible overlapping work');await turn();old.click(f.event());await turn();assert.equal(f.commands.length,0);
});
test('fresh public cancellation uses the currently refreshed job version once',async t=>{
 const f=await fixture(t),q=f.getQueue();q.jobs[0].version='9';f.setQueue(q);await refresh(f);f.click(cancel);await until(()=>f.commands.length===1);assert.deepEqual(f.commands[0],{type:'CancelJob',jobId:'job',attemptId:'attempt',expectedVersion:'9'});f.cancellation.resolve();await settled(f);
});
test('a refreshed queue refuses the old callback and never rewrites or replays a rejected current payload',async t=>{
 const f=await fixture(t),old=f.button(cancel),q=f.getQueue();q.jobs[0].version='9';f.setQueue(q);await refresh(f);f.editor.command=async body=>{f.commands.push(body);throw Error('fixture stale expectedVersion');};
 old.click(f.event());await turn();assert.deepEqual(f.commands,[],'The old rendered page cannot authorize a command after refresh');
 f.click(cancel);await until(()=>f.commands.length===1);await settled(f);await turn();assert.deepEqual(f.commands,[{type:'CancelJob',jobId:'job',attemptId:'attempt',expectedVersion:'9'}]);assert.match(f.render().errors.join(' '),/fixture stale expectedVersion/);await turn();assert.equal(f.commands.length,1,'A rejected payload is never rewritten or replayed');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,rendered,deferred,until} from './deletion-controls.mjs';

test('an inspection completed for a previous owner cannot publish replacement job controls',async()=>{
 const f=fixture();await f.open();const read=deferred();let readStarted=false;
 f.editor.json=async()=>{readStarted=true;return read.promise;};
 f.click('Refresh deleted request state');
 await until(()=>readStarted&&rendered(f.flow).busy==='true');
 f.setIdentity('replacement-owner');
 const oldJob={id:'old_owner_job',version:'9',attempts:[{id:'old_attempt',state:'submission-uncertain',hold:true}]};
 read.resolve({receipt:f.receipt,jobs:[oldJob],next:null});
 await f.settled();
 assert.equal(rendered(f.flow).busy,'false');
 assert.equal(f.commands.length,0);
 assert.ok(!rendered(f.flow).buttons.some(b=>b.name==='Check deleted request old_owner_job, attempt old_attempt (submission-uncertain)'),'An old-owner read must not publish enabled request controls under the replacement owner');
});

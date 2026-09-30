import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,cancel,turn} from './queue-controls.mjs';
test('held recovery remains publicly unavailable after a refresh clears recoveryRequired',async t=>{
 const f=await fixture(t);await f.heldRecovery();await f.refreshedRecovery();
 try{assert.equal(f.button(cancel).disabled,true,'Cancel must remain disabled until RecoverJob settles');}
 finally{f.recovery.resolve();await turn();}
 assert.deepEqual(f.commands.map(c=>c.type),['RecoverJob']);
});

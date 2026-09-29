import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,rendered} from './deletion-controls.mjs';

test('public receipt inspection settles without retaining an in-progress saving status',async()=>{
 const f=fixture();await f.open();const view=rendered(f.flow);
 assert.equal(view.busy,'false');
 assert.equal(f.button('Review possible overlap for deleted request').disabled,false);
 assert.doesNotMatch(view.text,/Saving deletion choice…/,'Settled inspection must not advertise saving');
 assert.equal(f.commands.length,0);
});

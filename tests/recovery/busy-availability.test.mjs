import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,rendered} from './deletion-controls.mjs';

test('actual deletion render makes overlap review unavailable while collection is unresolved',async t=>{
 const f=fixture();await f.open();await f.collect();
 try{
  assert.deepEqual(f.commands.map(c=>c.type),['CollectDocumentGarbage']);
  t.diagnostic(JSON.stringify({phase:'collection-held',controls:rendered(f.flow).buttons.map(({name,disabled})=>({name,disabled})),commands:f.commands}));
  assert.equal(f.button('Review possible overlap for deleted request').disabled,true,'An unresolved collection must make overlap review unavailable through en-button disabled semantics');
 }finally{f.hold.resolve();await f.settled();}
});

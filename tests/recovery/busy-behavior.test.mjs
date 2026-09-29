import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,rendered,until} from './deletion-controls.mjs';

const review='Review possible overlap for deleted request';
const acknowledge='Acknowledge overlap and release deleted request hold';
const collect='Check and reclaim eligible bytes';
async function reviewed(f){f.click(review);await until(()=>rendered(f.flow).buttons.some(b=>b.name===acknowledge));await f.settled();assert.match(rendered(f.flow).text,/does not cancel, refund or erase it/);}

test('all rendered sibling actions advertise unavailable while collection holds the controller',async()=>{
 const f=fixture();await f.open();await f.collect();
 try{assert.equal(rendered(f.flow).busy,'true');assert.ok(rendered(f.flow).buttons.some(b=>b.name==='Next deletion receipts'));assert.ok(rendered(f.flow).buttons.some(b=>b.name==='Next deleted requests'));for(const b of rendered(f.flow).buttons)assert.equal(b.disabled,true,b.name);}
 finally{f.hold.resolve();await f.settled();}
 assert.equal(rendered(f.flow).busy,'false');
});

test('settlement never replays a busy click; fresh review and separate acknowledgement send one exact override',async()=>{
 const f=fixture();await f.open();const staleReview=f.button(review);await f.collect();
 staleReview.click(f.event());await new Promise(r=>setTimeout(r,0));assert.deepEqual(f.commands.map(c=>c.type),['CollectDocumentGarbage']);
 f.hold.resolve();await f.settled();assert.ok(!rendered(f.flow).buttons.some(b=>b.name===acknowledge));await reviewed(f);assert.equal(f.commands.length,1);
 f.click(acknowledge);await until(()=>f.commands.length===2);await f.settled();
 assert.deepEqual(f.commands[1],{type:'OverrideUncertainHold',jobId:'job',attemptId:'attempt',expectedVersion:'7',acknowledgeOverlapAndChargeRisk:true});assert.ok(!rendered(f.flow).buttons.some(b=>b.name===acknowledge));
});

test('two dispatched collection actions perform one held command with no queued replay',async()=>{
 const f=fixture();await f.open();const b=f.button(collect),e=f.event();b.click(e);b.click(e);await until(()=>f.commands.length===1&&rendered(f.flow).busy==='true');await new Promise(r=>setTimeout(r,0));
 assert.equal(f.commands.length,1);f.hold.resolve();await f.settled();assert.equal(f.commands.length,1);
});

test('an unresolved operation never makes sibling actions available or acknowledges overlap',async()=>{
 const f=fixture();await f.open();await f.collect();
 try{for(let i=0;i<3;i++){await new Promise(setImmediate);assert.equal(f.button(review).disabled,true);assert.equal(rendered(f.flow).busy,'true');}assert.equal(f.commands.length,1);}
 finally{f.hold.resolve();await f.settled();}
});

test('failed collection settles visibly without issuing a review or override',async()=>{
 const f=fixture();await f.open();await f.collect();f.hold.reject(Error('fixture collection failure'));await f.settled();
 assert.match(rendered(f.flow).text,/fixture collection failure/);assert.equal(f.button(review).disabled,false);assert.equal(rendered(f.flow).busy,'false');assert.deepEqual(f.commands.map(c=>c.type),['CollectDocumentGarbage']);assert.ok(!rendered(f.flow).buttons.some(b=>b.name===acknowledge));
});

for(const boundary of ['late-veto','identity','draft-owner','dispose','detach'])test('a rendered acknowledgement cannot cross '+boundary,async()=>{
 const f=fixture();await f.open();await reviewed(f);const b=f.button(acknowledge),e=f.event();b.click(e);
 if(boundary==='late-veto')e.defaultPrevented=true;if(boundary==='identity')f.setIdentity('replacement');if(boundary==='draft-owner')f.editor.draftOwner={drafts:new Map()};if(boundary==='dispose')f.flow.dispose();if(boundary==='detach')e.currentTarget.isConnected=false;
 await new Promise(r=>setTimeout(r,0));assert.equal(f.commands.length,0);
});

test('a superseded review callback cannot acknowledge after a fresh public inspection',async()=>{
 const f=fixture();await f.open();await reviewed(f);const old=f.button(acknowledge);f.click('Refresh deleted request state');await until(()=>!rendered(f.flow).buttons.some(b=>b.name===acknowledge));await f.settled();old.click(f.event());await new Promise(r=>setTimeout(r,0));assert.equal(f.commands.length,0);
});

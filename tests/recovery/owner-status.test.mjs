import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,rendered,deferred,until} from './deletion-controls.mjs';
const review='Review possible overlap for deleted request',ack='Acknowledge overlap and release deleted request hold';
const names={preview:'Review document deletion',confirm:'Confirm permanent document deletion',collect:'Check and reclaim eligible bytes',recover:'Check existing deleted request job',override:ack,copy:'Save a complete copy first',list:'Review pending document cleanup',inspect:'Refresh deleted request state'};
// Cross the adapter's deferred dispatch task before inspecting completion.
const drain=async()=>{await new Promise(r=>setTimeout(r,0));await new Promise(setImmediate);};
const status=f=>rendered(f.flow).text;
async function setup(op){
 const f=fixture(),calls=[];f.editor.view.document={id:'deleted_doc',revision:'1'};
 const plan={id:'plan',documentId:'deleted_doc',documentRevision:'1',rootGeneration:'root',planHash:'hash',histories:1,checkpoints:0,drafts:0,jobs:1,exclusiveBytes:'8',retainedBytes:'3',pendingBytes:'0',retainedRoots:[],unresolvedAttempts:[]};
 let gate=null,step=0,at=0,entered=false,deleteResult='target',copyCount=0;
 async function pause(kind,value){calls.push({kind,value});step++;if(gate&&step===at){entered=true;await gate.promise;}}
 f.editor.command=async body=>{f.commands.push(body);await pause('command',body.type);if(body.type==='DeleteDocument'){if(deleteResult==='target'||deleteResult==='wrong-ack')f.editor.view.document=null;else if(deleteResult==='other')f.editor.view.document={id:'other',revision:'1'};else if(deleteResult==='revision')f.editor.view.document.revision='2';else if(deleteResult==='identity')f.setIdentity('replacement');return [{type:'DocumentDeleted',payload:{id:deleteResult==='wrong-ack'?'other':'deleted_doc'}}];}if(body.type==='CollectDocumentGarbage'){f.receipt.status='cleanup-complete';f.receipt.actualFreedBytes='8';f.receipt.pendingBytes='0';}return [];};
 f.editor.json=async path=>{await pause('read',path);return path.startsWith('/api/v1/deletions?')?{items:[f.receipt],next:'next_receipt'}:{plan,receipt:f.receipt,jobs:[f.job],next:'next_job'};};
 f.editor.copy=async()=>{copyCount++;await pause('copy','copy');};
 async function invoke(name){f.click(name);await until(()=>rendered(f.flow).busy==='true'||calls.length>0);await drain();await f.settled();}
 if(['confirm','copy'].includes(op)){await invoke(names.preview);assert.ok(f.button(names.confirm));}
 if(['inspect','collect','recover','override'].includes(op)){await f.open();if(op==='override'){f.click(review);await until(()=>rendered(f.flow).buttons.some(b=>b.name===ack));await f.settled();}}
 calls.length=0;f.commands.length=0;step=0;
 return Object.assign(f,{calls,plan,copyCount:()=>copyCount,setDelete:v=>deleteResult=v,hold(n=1){at=n;gate=deferred();entered=false;return gate;},start(){f.click(names[op]);},entered:()=>entered,drain,invoke});
}
const changes={
 'session object':f=>{f.editor.session={identity:()=> 'client'};},
 'session identity':f=>f.setIdentity('replacement'),
 'draft owner':f=>{f.editor.draftOwner={drafts:new Map()};},
 'lifetime':f=>f.flow.dispose(),
 'composition':f=>{f.editor.draftOwner.drafts.set('draft',{generation:'1',savedGeneration:'1',composing:true});},
 'document':f=>{f.editor.view.document={id:'other',revision:'1'};},
 'revision':f=>{f.editor.view.document.revision='2';},
 'unsaved draft':f=>{f.editor.draftOwner.drafts.set('draft',{generation:'2',savedGeneration:'1',pending:true});}
};
for(const op of ['list','inspect'])for(const [boundary,change] of Object.entries(changes))for(const outcome of ['success','rejection'])test(`${op} ${outcome} cannot publish across ${boundary}`,async()=>{
 const f=await setup(op),g=f.hold();f.start();await until(f.entered);change(f);rendered(f.flow);
 if(outcome==='success')g.resolve();else g.reject(Error('old-owner failure'));
 await drain();assert.equal(f.commands.length,0);assert.equal(rendered(f.flow).busy,'false');assert.ok(!rendered(f.flow).buttons.some(b=>b.name.includes('Inspect cleanup for')||b.name===review));assert.doesNotMatch(status(f),/old-owner failure|Receipt inspected:|Retained deletion receipts are available/);
});
const points=[['preview',1],['preview',2],['confirm',1],['confirm',2],['confirm',3],['collect',1],['collect',2],['recover',1],['recover',2],['override',1],['override',2],['copy',1]];
const terminal={preview:/Review the affected history/,confirm:/Document deleted; cleanup pending\. No space/,collect:/Document cleanup complete\./,recover:/Checking this existing deleted-document request\./,override:/Local hold released after your risk acknowledgement\./,copy:/Copy prepared; external destination remains unconfirmed/};
for(const [op,point]of points)for(const outcome of ['success','rejection'])test(`${op} boundary ${point} has truthful pending and ${outcome} completion`,async()=>{
 const f=await setup(op),g=f.hold(point);f.start();await until(f.entered);assert.equal(rendered(f.flow).busy,'true');assert.ok(rendered(f.flow).buttons.every(b=>b.disabled));assert.match(status(f),/…/);assert.doesNotMatch(status(f),/Saving deletion choice/);
 if(outcome==='success')g.resolve();else g.reject(Error('fixture boundary failure'));
 await drain();await f.settled();assert.equal(rendered(f.flow).busy,'false');
 if(outcome==='success')assert.match(status(f),terminal[op]);else assert.match(status(f),/fixture boundary failure/);
 assert.equal(f.calls.length,outcome==='rejection'?point:({preview:2,confirm:3,collect:2,recover:2,override:2,copy:1})[op]);
});
for(const [op,point]of [['confirm',1],['confirm',2],['collect',1],['recover',1],['override',1]])test(`${op} boundary ${point} suppresses stale follow-up reads and commands`,async()=>{
 const f=await setup(op),g=f.hold(point);f.start();await until(f.entered);f.setIdentity('replacement');rendered(f.flow);g.resolve();await drain();assert.equal(f.calls.length,point);assert.equal(f.commands.length,1);assert.ok(!rendered(f.flow).buttons.some(b=>b.name===review));
});
for(const outcome of ['success','rejection'])test(`old ${outcome} cannot finalize or replace a newer busy action`,async()=>{
 const f=await setup('inspect'),old=f.hold();f.start();await until(f.entered);f.setIdentity('replacement');rendered(f.flow);
 const newer=deferred();let entered=false;f.editor.json=async()=>{entered=true;return newer.promise;};f.click(names.list);await until(()=>entered&&rendered(f.flow).busy==='true');
 if(outcome==='success')old.resolve();else old.reject(Error('old failure'));await drain();assert.equal(rendered(f.flow).busy,'true');assert.match(status(f),/Loading retained deletion receipts…/);assert.doesNotMatch(status(f),/old failure/);
 newer.resolve({items:[],next:null});await drain();await f.settled();assert.match(status(f),/Retained deletion receipts are available/);
});
for(const boundary of ['session object','session identity','draft owner'])test(`retained controls and callbacks are invalidated by ${boundary}`,async()=>{
 const f=await setup('override'),old=f.button(ack);changes[boundary](f);const v=rendered(f.flow);assert.ok(!v.buttons.some(b=>b.name===ack||b.name===review||b.name.includes('Inspect cleanup for')));old.click(f.event());await drain();assert.equal(f.commands.length,0);
});
for(const transition of ['target','wrong-ack','other','revision','identity'])test(`confirmation permits only the acknowledged target transition: ${transition}`,async()=>{
 const f=await setup('confirm');f.setDelete(transition);if(transition==='target')f.receipt.status='cleanup-complete';f.start();await until(()=>f.commands.length===1);await drain();await f.settled();
 if(transition==='target'){assert.equal(f.editor.view.document,null);assert.equal(f.calls.length,3);assert.match(status(f),/Document deleted; retained receipt reports cleanup complete\./);assert.ok(f.button(review));}
 else{assert.equal(f.calls.length,1);assert.ok(!rendered(f.flow).buttons.some(b=>b.name===review));assert.doesNotMatch(status(f),terminal.confirm);}
});
for(const kind of ['receipt page','job page','refresh','risk review','list error'])test(`public ${kind} has a settled truthful status`,async()=>{
 const f=await setup('inspect');
 if(kind==='list error'){f.editor.json=async()=>{throw Error('receipt list failure');};f.click(names.list);await drain();await f.settled();assert.match(status(f),/receipt list failure/);}
 else{const label=kind==='receipt page'?'Next deletion receipts':kind==='job page'?'Next deleted requests':kind==='risk review'?review:names.inspect;f.click(label);await drain();await f.settled();assert.match(status(f),kind==='receipt page'?/Retained deletion receipts are available/:kind==='risk review'?/No hold has been released\./:/Receipt inspected: document cleanup is pending\./);if(kind==='receipt page')assert.ok(f.calls.some(c=>c.value.endsWith('after=next_receipt')));if(kind==='job page')assert.ok(f.calls.some(c=>c.value.endsWith('after=next_job')));}
 assert.equal(f.commands.length,0);assert.equal(rendered(f.flow).busy,'false');assert.doesNotMatch(status(f),/Saving deletion choice/);
});
test('an unsettled read retains truthful pending state without replaying another click',async()=>{
 const f=await setup('inspect'),old=f.button(review),g=f.hold();f.start();await until(f.entered);old.click(f.event());await drain();assert.equal(rendered(f.flow).busy,'true');assert.match(status(f),/Refreshing retained deleted-request state…/);assert.equal(f.commands.length,0);assert.equal(f.calls.length,1);g.resolve();await drain();await f.settled();assert.ok(!rendered(f.flow).buttons.some(b=>b.name===ack));
});

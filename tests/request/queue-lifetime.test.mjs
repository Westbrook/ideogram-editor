import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,recover,cancel,until,turn,deferred} from './queue-controls.mjs';
async function edit(f,kind){
 if(kind==='prompt'){const host={value:'Edited while pending',isConnected:true};f.render().fields.find(x=>x.id==='prompt').input({currentTarget:host,composedPath:()=>[host],defaultPrevented:false});await turn();}
 if(kind==='operation')f.flow.operationChanged('Generate with Fast');
 if(kind==='revision'){f.editor.view.document.revision='2';await f.flow.sync();}
}
for(const name of [recover,cancel])for(const change of ['prompt','operation','revision'])for(const outcome of ['resolve','reject'])test('F4 '+name+' '+outcome+' after '+change+' releases its continuing owner busy state',async t=>{
 const f=await fixture(t);f.click(name);await until(()=>f.commands.length===1);assert.equal(f.render().busy,'true');await edit(f,change);f[name===recover?'recovery':'cancellation'][outcome](outcome==='reject'?Error('held command rejected'):undefined);await turn();await turn();assert.equal(f.render().busy,'false');assert.equal(f.button(recover).disabled,false);assert.equal(f.button(cancel).disabled,false);assert.equal(f.commands.length,1);assert(!/Saving cancellation request|Checking the existing request/.test(f.render().text));
});
for(const replacement of ['owner','session','identity'])for(const outcome of ['resolve','reject'])test('F4 follow-up refresh '+outcome+' cannot publish into replacement '+replacement,async t=>{
 const f=await fixture(t),read=deferred(),json=f.editor.json;let entered=false;
 f.editor.json=async path=>{if(path.startsWith('/api/v1/queue')){entered=true;return read.promise;}return json(path);};f.click(recover);await until(()=>f.commands.length===1);f.recovery.resolve();await until(()=>entered);
 if(replacement==='owner')f.editor.draftOwner={drafts:new Map()};if(replacement==='session')f.editor.session={identity:()=> 'new-session'};if(replacement==='identity')f.setIdentity('new-identity');
 const before=f.render().text;read[outcome](outcome==='resolve'?f.getQueue():Error('obsolete refresh failed'));await turn();await turn();assert.equal(f.render().text,before);assert.ok(!f.render().errors.some(x=>/obsolete/.test(x)));assert.equal(f.commands.length,1);
});
test('F4 old command settlement cannot release a replacement owner action',async t=>{
 const f=await fixture(t);f.click(recover);await until(()=>f.commands.length===1);f.editor.draftOwner={drafts:new Map()};await f.flow.sync();f.click('Refresh durable queue');await until(()=>f.render().buttons.some(b=>b.name===cancel));f.click(cancel);await until(()=>f.commands.length===2);f.recovery.resolve();await turn();assert.equal(f.render().busy,'true');assert.equal(f.button(cancel).disabled,true);f.cancellation.resolve();await until(()=>f.render().busy==='false');assert.deepEqual(f.commands.map(x=>x.type),['RecoverJob','CancelJob']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,prepare,enqueue,auth,envelope,encode,legacyAcknowledgement} from '../queue/helpers.mjs';
import {resolvePrivacy} from '../../dist/local/server/provider/policy.js';
import {fixtureProfile} from '../provider/emulator.mjs';
import {uiModule,uiModelOwnerURL,ownFixtureJSON,allocationsURL} from '../ui-model-module.mjs';
import {ownFixtureCommands} from '../owned-command-fixture.mjs';
import {allocationDeltaSnapshot} from '../owned-preview-module.mjs';

// Real writer, durable queue/deletion commands and actual UI controller/adapter.
// The host commit and the provider's uncertain acknowledgement are explicit
// fixtures. No provider, image, result or new-request transport is invoked.
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const lit=data('export const nothing=null;export function html(strings,...values){return {strings,values};}');
const adapter=await uiModule('src/ui/adapters.ts');
const {DocumentDeletion}=await import(await uiModule('src/ui/deletion.ts',{'lit':lit,'./adapters.js':adapter,'./model-owner.js':uiModelOwnerURL}));
const {allocationLedger}=await import(allocationsURL);
const snapshot=allocationDeltaSnapshot(allocationLedger);
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(predicate){const deadline=Date.now()+2000;while(!predicate()){assert(Date.now()<deadline,'Deletion UI did not settle');await turn();}}
function buttons(template){
 const slots=[];
 const render=value=>value===null||value===undefined?'':Array.isArray(value)?value.map(render).join(''):value?.strings?value.strings.reduce((out,text,i)=>out+text+(i<value.values.length?render(value.values[i]):''),''):'__slot'+(slots.push(value)-1)+'__';
 return [...render(template).matchAll(/<en-button\b([^>]*)>([\s\S]*?)<\/en-button>/g)].map(([,attributes,title])=>{
  const click=/@click=__slot(\d+)__/.exec(attributes),disabled=/\?disabled=__slot(\d+)__/.exec(attributes);
  return {title:title.replace(/__slot(\d+)__/g,(_,i)=>String(slots[Number(i)])).trim(),disabled:disabled?Boolean(slots[Number(disabled[1])]):false,click:click?slots[Number(click[1])]:undefined};
 });
}
function event(){const target={isConnected:true};return {currentTarget:target,composedPath:()=>[target],defaultPrevented:false};}
async function setup(t){
 const f=await fixture(t),w=f.writer,send=async body=>{const receipt=await w.queueCommand(encode(envelope(body)),auth());assert.equal(receipt.status,'accepted',JSON.stringify(receipt));return receipt;};
 const queued=await enqueue(w,(await prepare(w)).body),jobId=queued.job.id,attemptA=queued.job.attempts[0].id;
 const policy=resolvePrivacy(fixtureProfile(),'ideogram/v4','fixture').applied;
 await w.queueReserve(jobId);const dispatch=await w.queueDispatch(jobId,attemptA,{},policy);
 const acknowledgement=legacyAcknowledgement(f.root,attemptA,'known-original',{status:'http://127.0.0.1:1/status',result:'http://127.0.0.1:1/result',cancel:'http://127.0.0.1:1/cancel'},policy);
 await w.queueOutcome(jobId,attemptA,dispatch.epoch,acknowledgement);
 const acknowledged=await w.queueRecovery(jobId,attemptA);assert.equal(acknowledged.outbox.responseRecord,acknowledgement.responseRecord);assert.equal(acknowledged.outbox.wireEvidence.submission,null);
 await w.queueOutcome(jobId,attemptA,dispatch.epoch,{kind:'uncertain',reason:'Fixture interruption after durable provider identity'});
 let job=(await w.queueView()).jobs.find(value=>value.id===jobId);
 await send({type:'OverrideUncertainHold',jobId,attemptId:attemptA,expectedVersion:job.version,acknowledgeOverlapAndChargeRisk:true});
 job=(await w.queueView()).jobs.find(value=>value.id===jobId);
 await send({type:'RetryUncertainJob',jobId,attemptId:attemptA,expectedVersion:job.version,acknowledgeDuplicateWorkAndChargeRisk:true});
 job=(await w.queueView()).jobs.find(value=>value.id===jobId);const attemptB=job.attempts.at(-1).id;
 assert.notEqual(attemptA,attemptB);assert.equal(job.attempts.at(-1).state,'not-started');
 await send({type:'PreviewDocumentDeletion',documentId:'document_1',expectedRevision:await w.documentRevision('document_1')});
 const plan=(await w.deletionView('document_1',auth())).plan;
 await send({type:'DeleteDocument',documentId:plan.documentId,planId:plan.id,planHash:plan.planHash,expectedRevision:plan.documentRevision,rootGeneration:plan.rootGeneration,acknowledgeRunningAndUncertain:true});
 assert.equal(await w.document('document_1'),null);
 const before=(await w.queueView()).jobs.find(value=>value.id===jobId);
 assert.equal(before.attempts[0].requestId,'known-original');assert.equal(before.attempts[0].recoveryRequired,true);
 assert.equal(before.attempts[0].override,true);assert.equal(before.attempts[0].hold,false);
 assert.equal(before.attempts.at(-1).state,'locally-cancelled');assert.equal(before.attempts.at(-1).requestId,null);
 const commands=[],reads=[];
 const editor={session:{identity:()=> 'client_1'},view:{document:null,busy:false},draftOwner:{drafts:new Map()},copy:async()=>assert.fail('No copy action expected'),
  async command(body){commands.push(body);await send(body);return [];},
  async json(path){reads.push(path);const parsed=new URL(path,'http://127.0.0.1');if(parsed.pathname==='/api/v1/deletions')return w.deletionList(parsed.searchParams.get('after')??'');assert.equal(parsed.pathname,'/api/v1/documents/document_1/deletion');return w.deletionView('document_1',auth(),parsed.searchParams.get('after')??'');},
 };
 const flow=new DocumentDeletion({requestUpdate(){},updateComplete:Promise.resolve(true)},ownFixtureCommands(ownFixtureJSON(editor)));
 const find=title=>{const value=buttons(flow.render()).find(value=>value.title===title);assert(value,'Missing rendered action: '+title);assert.equal(value.disabled,false);return value;};
 const idle=()=>until(()=>!flow.busy&&flow.lifecycle.pending===0&&flow.lifecycle.reads===0);
 const click=async title=>{find(title).click(event());await turn();await idle();};
 const close=async()=>{await flow.dispose();assert.equal(snapshot().activeRecords,0);assert.equal(snapshot().cpuBytes,0);};
 try{await click('Review pending document cleanup');await click('Inspect cleanup for document_1');}catch(error){await close();throw error;}
 return {w,editor,flow,commands,reads,jobId,attemptA,attemptB,before,find,click,idle,close,label:(id,state)=>'Check deleted request '+jobId+', attempt '+id+' ('+state+')'};
}

test('deleted receipt reaches the original uncertain attempt after override and a cancelled successor without opening a document',async t=>{
 const f=await setup(t);try{
  const original=f.label(f.attemptA,'submission-uncertain'),successor=f.label(f.attemptB,'locally-cancelled');
  f.find(original);f.find(successor);const counts=(await f.w.queueView()).counts;
  await f.click(original);
  assert.deepEqual(f.commands,[{type:'RecoverJob',jobId:f.jobId,attemptId:f.attemptA,expectedVersion:f.before.version}]);
  const after=(await f.w.queueView()).jobs.find(job=>job.id===f.jobId),a=after.attempts[0],b=after.attempts.at(-1);
  assert.equal(a.recoveryRequired,false);assert.equal(a.recoveryRequested,true);assert.equal(a.requestId,'known-original');
  assert.equal(a.hold,false);assert.equal(a.override,true);assert.equal(a.count,'dispatched');
  assert.equal(b.recoveryRequired,true);assert.equal(b.recoveryRequested,false);assert.equal(b.state,'locally-cancelled');
  assert.equal(after.attempts.length,2);assert.deepEqual((await f.w.queueView()).counts,counts);
  assert.equal(f.editor.view.document,null);assert.equal(await f.w.document('document_1'),null);
  assert(f.reads.every(path=>path.startsWith('/api/v1/deletions?')||path.startsWith('/api/v1/documents/document_1/deletion')));
 }finally{await f.close();}
});

test('superseded and owner-stale deleted-attempt controls cannot redirect a recovery check',async t=>{
 const f=await setup(t);try{
  const label=f.label(f.attemptA,'submission-uncertain'),old=f.find(label);
  await f.click('Refresh deleted request state');old.click(event());await turn();await f.idle();assert.deepEqual(f.commands,[]);
  const current=f.find(label);current.click(event());f.editor.draftOwner={drafts:new Map()};await turn();await f.idle();assert.deepEqual(f.commands,[]);
  assert.equal(f.editor.view.document,null);assert.equal((await f.w.queueRecovery(f.jobId,f.attemptA)).attempt.recoveryRequired,true);
 }finally{await f.close();}
});

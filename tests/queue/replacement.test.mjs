import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture,prepare,enqueue,caption,auth,envelope,encode} from './helpers.mjs';
import {resolveInactive} from '../../dist/local/src/request/core.js';
import {resolvePrivacy} from '../../dist/local/server/provider/policy.js';
import {fixtureProfile} from '../provider/emulator.mjs';
import {childFor} from '../store/helpers.mjs';

const policy=resolvePrivacy(fixtureProfile(),'ideogram/v4','queue-edit').applied;
const sql=(root,query,...args)=>{const db=new DatabaseSync(join(root,'metadata.sqlite'),{readOnly:true});try{return db.prepare(query).all(...args);}finally{db.close();}};
const edit=(job,state,replacementDraftId=randomUUID())=>envelope({type:'EditQueuedJob',jobId:job.id,expectedVersion:job.version,sessionId:state.sessionId,expectedUISeq:state.uiSeq,replacementDraftId});
const asset=(root,id)=>JSON.parse(sql(root,'SELECT json FROM assets WHERE id=?',id)[0].json);
const objectPath=(root,ref)=>join(root,'objects/sha256',ref.hash.slice(7,9),ref.hash.slice(7));
async function queued(writer){const prepared=await prepare(writer,d=>{d.fields.strength='0.37';resolveInactive(d,'strength');});return enqueue(writer,prepared.body);}
async function persistTo(writer,sessionId,body){const state=await writer.uiRead(sessionId,auth());return writer.uiPersist(encode({protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:state.uiSeq,body}),auth());}

test('edit creates an exact replacement draft and atomically cancels only the original waiting intent',async t=>{
 const f=await fixture(t),{job}=await queued(f.writer),frozen=structuredClone(job),authored=asset(f.root,job.review.draftAsset),bytes=await readFile(objectPath(f.root,authored.blob));
 // The queue owns its authored input; editing the original UI draft later must
 // neither change the queue nor make replacement reconstruct lossy settings.
 await prepare(f.writer,d=>d.fields.seed='123','2');const before=await f.writer.uiRead('request_session',auth()),request=edit(job,before,'replacement_draft'),receipt=await f.writer.queueCommand(encode(request),auth());assert.equal(receipt.status,'accepted');
 const state=await f.writer.uiRead('request_session',auth()),replacement=state.drafts.find(draft=>draft.id==='replacement_draft');assert(replacement);assert.equal(replacement.kind,'request');assert.equal(replacement.generation,'1');assert.equal(replacement.status,'saved-unapplied');assert.equal(replacement.composing,false);assert.equal(replacement.documentId,job.documentId);assert.equal(replacement.expectedDocumentRevision,job.review.documentRevision);assert.equal(replacement.assetId,job.review.draftAsset);assert.deepEqual(state.drafts.find(draft=>draft.id==='queue_draft'),before.drafts.find(draft=>draft.id==='queue_draft'));assert.equal(state.drafts.length,before.drafts.length+1);
 const copied=asset(f.root,replacement.assetId);assert.deepEqual(await readFile(objectPath(f.root,copied.blob)),bytes);assert.equal(JSON.parse(bytes).fields.strength,'0.37');assert(JSON.parse(bytes).inactive.strength);
 const view=await f.writer.queueView(),cancelled=view.jobs.find(item=>item.id===job.id);assert.equal(view.totalJobs,1);assert.equal(cancelled.local,'locally-cancelled');assert.equal(cancelled.attempts.length,1);assert.equal(cancelled.attempts[0].state,'locally-cancelled');assert.equal(cancelled.attempts[0].hold,false);assert.equal(cancelled.attempts[0].count,'none');assert.deepEqual(cancelled.review,frozen.review);assert.deepEqual(cancelled.stagePlan,frozen.stagePlan);assert.equal(sql(f.root,'SELECT * FROM queue_outbox').length,1);assert.equal(JSON.parse(sql(f.root,'SELECT json FROM queue_outbox')[0].json).state,'cancelled');assert.equal(view.counts.active,0);assert.equal(view.counts.dispatched,0);
 assert.deepEqual(await f.writer.queueCommand(encode(request),auth()),receipt);assert.deepEqual(await f.writer.uiRead('request_session',auth()),state);await f.reopen();assert.deepEqual(await f.writer.queueCommand(encode(request),auth()),receipt);assert.deepEqual(await f.writer.uiRead('request_session',auth()),state);
});

test('stale UI sequence and an existing replacement identity preserve waiting job and all drafts',async t=>{
 const f=await fixture(t),{job}=await queued(f.writer),before=await f.writer.uiRead('request_session',auth()),queue=await f.writer.queueView(),outbox=sql(f.root,'SELECT * FROM queue_outbox');
 for(const request of [edit(job,{...before,uiSeq:'0'}),edit(job,before,'queue_draft')]){const receipt=await f.writer.queueCommand(encode(request),auth());assert.equal(receipt.status,'rejected');assert.deepEqual(await f.writer.uiRead('request_session',auth()),before);assert.deepEqual(await f.writer.queueView(),queue);assert.deepEqual(sql(f.root,'SELECT * FROM queue_outbox'),outbox);}
});

test('replacement capacity rejection keeps the queued intent and all 64 destination drafts',async t=>{
 const f=await fixture(t),{job}=await queued(f.writer),saved=await caption(f.writer,'retained destination draft'),sessionId='full_destination';
 for(let i=0;i<64;i++){const receipt=await persistTo(f.writer,sessionId,{type:'SaveDraft',draft:{id:'kept_'+i,generation:'1',kind:'prompt',documentId:job.documentId,targetLayerId:null,expectedDocumentRevision:job.review.documentRevision,assetId:saved.id,composing:false}});assert.equal(receipt.status,'accepted');}
 const before=await f.writer.uiRead(sessionId,auth()),queue=await f.writer.queueView(),request=edit(job,before),receipt=await f.writer.queueCommand(encode(request),auth());assert.equal(receipt.status,'rejected');assert.equal(receipt.code,'CAPACITY');assert.deepEqual(await f.writer.uiRead(sessionId,auth()),before);assert.deepEqual(await f.writer.queueView(),queue);assert.deepEqual(await f.writer.queueCommand(encode(request),auth()),receipt);
});

test('the creating client can replace waiting work after restart and session renewal',async t=>{
 const f=await fixture(t),{job}=await queued(f.writer);await f.reopen();
 const renewed={...auth(),sessionHash:'b'.repeat(64)};await f.writer.rememberClient(renewed.sessionHash,renewed.clientId,renewed.expires);
 const before=await f.writer.uiRead('request_session',renewed),current=(await f.writer.queueView()).jobs.find(item=>item.id===job.id),request=edit(current,before,'renewed_replacement'),receipt=await f.writer.queueCommand(encode(request),renewed);assert.equal(receipt.status,'accepted');
 const checkpoint=await f.writer.uiRead('request_session',renewed);assert.equal(checkpoint.drafts.find(draft=>draft.id==='renewed_replacement').assetId,job.review.draftAsset);assert.equal((await f.writer.queueView()).jobs.find(item=>item.id===job.id).local,'locally-cancelled');assert.deepEqual(await f.writer.queueCommand(encode(request),renewed),receipt);
});

test('missing retained authored bytes cannot cancel the old intent or create a partial draft',async t=>{
 const f=await fixture(t),{job}=await queued(f.writer),state=await f.writer.uiRead('request_session',auth()),queue=await f.writer.queueView(),authored=asset(f.root,job.review.draftAsset),path=objectPath(f.root,authored.blob),bytes=await readFile(path);await unlink(path);
 try{const receipt=await f.writer.queueCommand(encode(edit(job,state)),auth());assert.equal(receipt.status,'rejected');assert.deepEqual(await f.writer.uiRead('request_session',auth()),state);assert.deepEqual(await f.writer.queueView(),queue);}finally{await writeFile(path,bytes,{mode:0o600});}
});

for(const mode of ['reserved','dispatching','uncertain'])test('edit refuses '+mode+' work while preserving holds, exact frozen request and outbox',async t=>{
 const f=await fixture(t),{job}=await queued(f.writer),reservation=await f.writer.queueReserve(job.id);assert(reservation);
 if(mode!=='reserved')assert(await f.writer.queueDispatch(job.id,reservation.attempt.id,{},policy));if(mode==='uncertain')await f.reopen();
 const before=await f.writer.queueView(),current=before.jobs.find(item=>item.id===job.id),state=await f.writer.uiRead('request_session',auth()),outbox=sql(f.root,'SELECT * FROM queue_outbox'),receipt=await f.writer.queueCommand(encode(edit(current,state)),auth());assert.equal(receipt.status,'rejected');assert.deepEqual(await f.writer.queueView(),before);assert.deepEqual(await f.writer.uiRead('request_session',auth()),state);assert.deepEqual(sql(f.root,'SELECT * FROM queue_outbox'),outbox);assert.equal(before.counts.active,1);
});

test('expired authenticated binding cannot edit a waiting request',async t=>{
 const f=await fixture(t),{job}=await queued(f.writer),state=await f.writer.uiRead('request_session',auth()),queue=await f.writer.queueView(),receipt=await f.writer.queueCommand(encode(edit(job,state)),{...auth(),now:Date.now()+7200000});assert.equal(receipt.status,'rejected');assert.deepEqual(await f.writer.queueView(),queue);assert.deepEqual(await f.writer.uiRead('request_session',auth()),state);
});

test('another paired client cannot claim a replacement for the creating client',async t=>{
 const f=await fixture(t),{job}=await queued(f.writer),foreign={...auth(),clientId:'client_2',sessionHash:'c'.repeat(64)};await f.writer.rememberClient(foreign.sessionHash,foreign.clientId,foreign.expires);
 const original=await f.writer.uiRead('request_session',auth()),destination=await f.writer.uiRead('foreign_session',foreign),queue=await f.writer.queueView(),request=edit(job,destination);request.command.clientId=foreign.clientId;
 const receipt=await f.writer.queueCommand(encode(request),foreign);assert.equal(receipt.status,'rejected');assert.deepEqual(await f.writer.queueView(),queue);assert.deepEqual(await f.writer.uiRead('request_session',auth()),original);assert.deepEqual(await f.writer.uiRead('foreign_session',foreign),destination);
});

for(const [phase,accepted]of [['asset-before-commit',false],['asset-after-commit',true]])test('replacement crash at '+phase+' retains cancellation and draft together or neither',async t=>{
 const f=await fixture(t),{job}=await queued(f.writer);await f.close();const child=await childFor(t,f.root,{phase}),state=await child.call('uiRead','request_session',auth()),before=await child.call('queueView'),current=before.jobs.find(item=>item.id===job.id),request=edit(current,state,'crash_replacement'),pending=child.call('queueCommand',encode(request),auth()).catch(error=>error);await child.wait('barrier');await child.assertNoEffects();await child.kill();await pending;
 await f.reopen();const lookup=await f.writer.lookup(request.command.commandId),after=await f.writer.queueView(),checkpoint=await f.writer.uiRead('request_session',auth());assert.equal(!!lookup,accepted);assert.equal(checkpoint.drafts.some(draft=>draft.id==='crash_replacement'),accepted);assert.equal(after.jobs.find(item=>item.id===job.id).local,accepted?'locally-cancelled':current.local);if(accepted)assert.deepEqual(await f.writer.queueCommand(encode(request),auth()),lookup.receipt);else assert.deepEqual(checkpoint,state);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {Histories} from '../../dist/local/server/storage/history.js';
import {Objects,PROOF_METADATA_BYTES} from '../../dist/local/server/storage/objects.js';
import {canonical,hashBytes,parseCommand} from '../../dist/local/server/storage/canonical.js';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';

const RGBA='application/x-ideogram-rgba8',R16='application/x-ideogram-r16le';
const emptyLeases={leases:0,proofs:0,metadataBytes:0};
const emptyProofs={pending:0,retained:0,activeReaders:0,metadataBytes:0};
const ref=(bytes,mediaType='application/json')=>({hash:hashBytes(bytes),byteLength:String(Buffer.byteLength(bytes)),mediaType});
const metadata=value=>ref(canonical(value));
const fail=name=>()=>assert.fail('Accepted review cancellation must not call '+name);
const unused=name=>new Proxy({}, {get:(_target,key)=>{assert.fail('Accepted review cancellation must not access '+name+'.'+String(key));}});

// Exercise Histories itself with real SQLite reads and genuine Objects proofs.
// Seed only the accepted-original boundary; unrelated history services are traps.
// Metadata references are deliberately not installed as roots or proof authority.
async function fixture(t){
  const root=await mkdtemp(join(await realpath(tmpdir()),'ideogram-review-cancellation-'));
  const db=new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
    INSERT INTO meta VALUES ('writerEpoch','7');
    CREATE TABLE commands (id TEXT PRIMARY KEY,hash TEXT NOT NULL,original TEXT NOT NULL,canonical TEXT NOT NULL,receipt TEXT NOT NULL) STRICT;
    CREATE TABLE client_bindings (cookie_hash TEXT PRIMARY KEY,client_id TEXT NOT NULL,expires TEXT NOT NULL) STRICT;
    CREATE TABLE events_v2 (seq TEXT PRIMARY KEY,transaction_id TEXT NOT NULL,command_id TEXT NOT NULL,json TEXT NOT NULL) STRICT;
    CREATE TABLE image_edit_reviews (id TEXT PRIMARY KEY,json TEXT NOT NULL,session_hash TEXT NOT NULL,epoch TEXT NOT NULL) STRICT;
  `);
  const objects=new Objects(root,()=>{},fail('Objects barrier'));
  const histories=new Histories(db,objects,unused('assets'),unused('rasters'),unused('ui'),unused('texts'),unused('candidates'),
    ()=>{},fail('history barrier'),fail('commit: an accepted receipt is immutable'),fail('document lookup'),fail('register'));
  const now=Date.now(),auth={clientId:'client_1',sessionHash:'a'.repeat(64),now,expires:now+120_000};
  const bind=value=>db.prepare('INSERT OR REPLACE INTO client_bindings VALUES (?,?,?)').run(value.sessionHash,value.clientId,String(value.expires));
  bind(auth);
  let serial=0,forbidReads=false;
  // Inspection of a proof's private file identity remains real. Neither cleanup
  // nor a missing lease may fall back to hashing or reading canonical raw bytes.
  for(const method of ['prove','verify','readRange','adoptFile']){
    const original=objects[method].bind(objects);
    objects[method]=(...args)=>{assert.equal(forbidReads,false,'Unexpected raw fallback: Objects.'+method);return original(...args);};
  }
  async function proof(bytes,mediaType){
    const value=ref(bytes,mediaType),path=objects.path(value);
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    if(!existsSync(path))await writeFile(path,bytes,{flag:'wx',mode:0o600});
    return {ref:value,token:await objects.prove(value,()=>{})};
  }
  async function seed({documentId='document_1',owner=auth,hold=true}={}){
    const index=++serial,commandId='review_command_'+index,reviewId='review_'+index;
    bind(owner);
    const proofs=[await proof(Buffer.from([index,80,140,255]),RGBA),await proof(Buffer.from([255,index]),R16)];
    const rgba=proofs[0].ref,mask=proofs[1].ref;
    const placement={candidateId:'candidate_'+index,mode:'safe-region',placement:'current-document',newDocumentId:null,actualOutput:null,newLayerId:'layer_'+index,name:'Reviewed candidate '+index};
    const request={protocolVersion:1,command:{schemaVersion:1,commandId,clientId:owner.clientId,sessionId:'provenance_session_'+index,
      correlationId:'correlation_'+index,causationId:null,transactionId:'transaction_'+index,documentId,expectedDocumentRevision:'3',
      expectedEntityVersions:EMPTY_EXPECTED_VERSIONS,issuedAt:new Date(now).toISOString(),body:{type:'ReviewCandidatePlacement',preparation:'encoded-rebuild',...placement}}};
    const original=canonical(request);
    assert.deepEqual(parseCommand(Buffer.from(original)),request,'Seed a valid canonical original command');
    const source={state:metadata({schemaVersion:1,width:1,height:1,layers:[]}),semanticDigest:hashBytes('source semantic identity'),compositeAssetId:'source_asset_'+index};
    const info=(pixels,role)=>({schemaVersion:1,pipeline:'cp1',width:1,height:1,manifest:metadata({pixels}),pixels,pixelIdentity:hashBytes(canonical(pixels)),role,sourceAssetIds:[],conversion:null});
    const encodedIdentity=(assetId,encoding)=>({assetId,assetVersion:'1',assetHash:hashBytes(assetId),info:info(rgba,'native'),encoding,encoded:ref('encoded '+assetId,'image/png'),encodedAssetId:assetId+'_encoded'});
    const encodedMask={encoded:ref('encoded mask '+index,'application/octet-stream'),pixels:mask,width:1,height:1,codec:'r16le-deflate-v1'};
    const identity={candidateId:placement.candidateId,candidateVersion:'1',documentId,jobId:'job_'+index,attemptId:'attempt_'+index,requestId:'request_'+index,
      outputIdentity:hashBytes('output '+index),preparedAssetId:'prepared_'+index,preparedAssetVersion:'1',preparedAssetHash:hashBytes('prepared '+index),requestHash:hashBytes('request '+index),jobVersion:'1',writerEpoch:'7'};
    const plan={kind:'request-raster-plan-1',kernel:'cp1-identity-grid-v1',reconstructionHalo:0,document:{width:1,height:1},domain:{x:0,y:0,width:1,height:1},
      expectedOutput:{width:1,height:1},sourcePixels:rgba,authoredMask:mask,effectiveMask:mask,dependenciesHash:hashBytes('dependencies '+index),resolution:'already-contained',approvalId:'approval_'+index,sourceToRequest:[1,0,0,1,0,0]};
    const content={protocolVersion:1,kind:'candidate-placement-review-1',reviewId,targetClientId:owner.clientId,expiresAt:new Date(now+60_000).toISOString(),documentId,documentRevision:'3',source,placement,
      inputs:{kind:'candidate-adoption-inputs-1',mode:'safe-region',identity,plan,sourceCapture:null,outputMapping:null,coverage:{originalEffectivePixels:1,effectivePixels:1,lostPixels:0},
        encodedRebuild:{kind:'encoded-adoption-inputs-1',source:encodedIdentity(source.compositeAssetId,'canonical-png'),candidate:encodedIdentity(identity.preparedAssetId,'candidate-original'),
          mask:{assetId:'mask_'+index,assetVersion:'1',assetHash:hashBytes('mask '+index),info:info(mask,'mask'),authored:encodedMask,effective:encodedMask,approved:encodedMask}}},
      preparation:'deferred',width:1,height:1};
    const review={...content,reviewHash:hashBytes(canonical(content))};
    const receipt={status:'accepted',commandId,fromSeq:String(index),toSeq:String(index),documentRevision:'3',transactionId:request.command.transactionId};
    const event={schemaVersion:1,payloadVersion:1,eventId:'event_'+index,workspaceSeq:String(index),streamId:documentId,streamSeq:'3',documentId,resultingDocumentRevision:'3',
      commandId,correlationId:request.command.correlationId,causationId:null,transactionId:request.command.transactionId,writerEpoch:'7',recordedAt:new Date(now).toISOString(),
      type:'CandidatePlacementReviewPrepared',payload:{reviewId,reviewHash:review.reviewHash}};
    db.prepare('INSERT INTO commands VALUES (?,?,?,?,?)').run(commandId,hashBytes(original),original,original,canonical(receipt));
    db.prepare('INSERT INTO events_v2 VALUES (?,?,?,?)').run(String(index),event.transactionId,commandId,canonical(event));
    db.prepare('INSERT INTO image_edit_reviews VALUES (?,?,?,?)').run(reviewId,canonical(review),owner.sessionHash,'7');
    const binding={reviewId,reviewHash:review.reviewHash,writerEpoch:'7',targetClientId:owner.clientId,documentId,sessionHash:owner.sessionHash,expiresAt:Date.parse(review.expiresAt)};
    // TypeScript private fields compile to ordinary properties. Access the actual
    // Histories-owned registry, without replacing its proof authority or methods.
    if(hold)histories.encodedReviewProofs.hold(binding,proofs);
    return {request,review,receipt,event,binding,proofs,commandId,reviewId};
  }
  const snapshot=()=>({
    commands:db.prepare('SELECT * FROM commands ORDER BY id').all(),
    events:db.prepare('SELECT * FROM events_v2 ORDER BY seq').all(),
    reviews:db.prepare('SELECT * FROM image_edit_reviews ORDER BY id').all(),
  });
  t.after(async()=>{await histories.close();objects.close();db.close();await rm(root,{recursive:true,force:true});});
  return {db,objects,histories,auth,bind,seed,snapshot,sealReads:()=>{forbidReads=true;}};
}

function inventory(f,leases,proofs=leases*2){
  assert.deepEqual(f.histories.encodedReviewProofInventory(),{leases,proofs,metadataBytes:proofs*PROOF_METADATA_BYTES});
  assert.deepEqual(f.objects.proofInventory(),{pending:0,retained:proofs,activeReaders:0,metadataBytes:proofs*PROOF_METADATA_BYTES});
}
function live(f,entry){for(const value of entry.proofs)assert.doesNotThrow(()=>f.objects.proven(value.ref,value.token));}
function released(f,entry){for(const value of entry.proofs)assert.throws(()=>f.objects.proven(value.ref,value.token),{code:'CORRUPT_OBJECT'});}
function updateCommand(f,entry,mutate){
  mutate(entry.request.command);const value=canonical(entry.request);
  f.db.prepare('UPDATE commands SET hash=?,original=?,canonical=? WHERE id=?').run(hashBytes(value),value,value,entry.commandId);
}
function updateEvent(f,entry,mutate){mutate(entry.event);f.db.prepare('UPDATE events_v2 SET json=? WHERE seq=?').run(canonical(entry.event),entry.event.workspaceSeq);}
function updateReview(f,entry,mutate,{rehash=true}={}){
  mutate(entry.review);
  if(rehash){const {reviewHash,...content}=entry.review;entry.review.reviewHash=hashBytes(canonical(content));updateEvent(f,entry,event=>{event.payload.reviewHash=entry.review.reviewHash;});}
  f.db.prepare('UPDATE image_edit_reviews SET json=? WHERE id=?').run(canonical(entry.review),entry.reviewId);
}

test('accepted original cancellation releases genuine RGBA/R16 leases and preserves the accepted receipt on repeats',async t=>{
  const f=await fixture(t),entry=await f.seed(),before=f.snapshot();f.sealReads();inventory(f,1);live(f,entry);
  assert.deepEqual(await f.histories.cancelCandidateReview(entry.commandId,f.auth),{protocolVersion:1,commandId:entry.commandId,status:'canceled'});
  inventory(f,0);released(f,entry);assert.deepEqual(f.snapshot(),before);
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT receipt FROM commands WHERE id=?').get(entry.commandId).receipt),entry.receipt);
  assert.deepEqual(await f.histories.cancelCandidateReview(entry.commandId,f.auth),{protocolVersion:1,commandId:entry.commandId,status:'completed'});
  inventory(f,0);assert.deepEqual(f.snapshot(),before);
});

test('another client or authenticated session cannot release an accepted original lease',async t=>{
  for(const kind of ['another client','another session','unbound session','expired auth','expired binding','invalid clock'])await t.test(kind,async t=>{
    const f=await fixture(t),entry=await f.seed();let auth={...f.auth};
    if(kind==='another client'){auth={...auth,clientId:'client_2',sessionHash:'b'.repeat(64)};f.bind(auth);}
    if(kind==='another session'){auth.sessionHash='b'.repeat(64);f.bind(auth);}
    if(kind==='unbound session')auth.sessionHash='c'.repeat(64);
    if(kind==='expired auth')auth.expires=auth.now;
    if(kind==='expired binding')f.bind({...auth,expires:auth.now});
    if(kind==='invalid clock')auth.now=NaN;
    const before=f.snapshot();f.sealReads();
    await assert.rejects(f.histories.cancelCandidateReview(entry.commandId,auth),{code:'OWNER_REQUIRED'});
    inventory(f,1);live(f,entry);assert.deepEqual(f.snapshot(),before);
  });
});

test('accepted original source-command, placement, hash and event mismatches reject without releasing proofs',async t=>{
  const cases=[
    ['source command type','MALFORMED_REQUEST',(f,e)=>updateCommand(f,e,c=>{c.body.type='PrepareCandidateAdoption';})],
    ['source preparation','MALFORMED_REQUEST',(f,e)=>updateCommand(f,e,c=>{delete c.body.preparation;})],
    ['source client','OWNER_REQUIRED',(f,e)=>updateCommand(f,e,c=>{c.clientId='client_2';})],
    ['source document','CORRUPT_STORE',(f,e)=>updateCommand(f,e,c=>{c.documentId='document_2';})],
    ['source revision','CORRUPT_STORE',(f,e)=>updateCommand(f,e,c=>{c.expectedDocumentRevision='4';})],
    ['source placement','CORRUPT_STORE',(f,e)=>updateCommand(f,e,c=>{c.body.name='Another placement';})],
    ['review placement','CORRUPT_STORE',(f,e)=>updateReview(f,e,r=>{r.placement.newLayerId='other_layer';})],
    ['review content digest','CORRUPT_STORE',(f,e)=>updateReview(f,e,r=>{r.width=2;},{rehash:false})],
    ['review hash','CORRUPT_STORE',(f,e)=>updateReview(f,e,r=>{r.reviewHash=hashBytes('incorrect review');},{rehash:false})],
    ['review candidate identity','CORRUPT_STORE',(f,e)=>updateReview(f,e,r=>{r.inputs.identity.candidateId='other_candidate';})],
    ['review document identity','CORRUPT_STORE',(f,e)=>updateReview(f,e,r=>{r.inputs.identity.documentId='other_document';})],
    ['review mode','CORRUPT_STORE',(f,e)=>updateReview(f,e,r=>{r.inputs.mode='full-candidate';})],
    ['missing encoded inputs','CORRUPT_STORE',(f,e)=>updateReview(f,e,r=>{delete r.inputs.encodedRebuild;})],
    ['event command','CORRUPT_STORE',(f,e)=>updateEvent(f,e,event=>{event.commandId='other_command';})],
    ['event transaction','CORRUPT_STORE',(f,e)=>updateEvent(f,e,event=>{event.transactionId='other_transaction';})],
    ['event hash','CORRUPT_STORE',(f,e)=>updateEvent(f,e,event=>{event.payload.reviewHash=hashBytes('other event');})],
    ['missing event','CORRUPT_STORE',(f,e)=>{f.db.prepare('DELETE FROM events_v2 WHERE command_id=?').run(e.commandId);}],
    ['duplicate event','CORRUPT_STORE',(f,e)=>{f.db.prepare('INSERT INTO events_v2 VALUES (?,?,?,?)').run('99',e.event.transactionId,e.commandId,canonical({...e.event,eventId:'duplicate_event',workspaceSeq:'99'}));}],
  ];
  for(const [name,code,mutate]of cases)await t.test(name,async t=>{
    const f=await fixture(t),entry=await f.seed();mutate(f,entry);const before=f.snapshot();f.sealReads();
    await assert.rejects(f.histories.cancelCandidateReview(entry.commandId,f.auth),{code});
    inventory(f,1);live(f,entry);assert.deepEqual(f.snapshot(),before);
  });
});

test('a consumed lease belongs to adoption; cancellation completes without releasing or recreating it',async t=>{
  const f=await fixture(t),entry=await f.seed(),before=f.snapshot();f.sealReads();
  const taken=f.histories.encodedReviewProofs.take(entry.binding);assert.deepEqual(taken,entry.proofs);
  assert.deepEqual(f.histories.encodedReviewProofInventory(),emptyLeases);live(f,entry);
  assert.deepEqual(await f.histories.cancelCandidateReview(entry.commandId,f.auth),{protocolVersion:1,commandId:entry.commandId,status:'completed'});
  assert.deepEqual(f.histories.encodedReviewProofInventory(),emptyLeases);
  assert.equal(f.objects.proofInventory().retained,2);live(f,entry);assert.deepEqual(f.snapshot(),before);
  for(const proof of taken)f.objects.releaseProof(proof.token);
  assert.deepEqual(f.objects.proofInventory(),emptyProofs);released(f,entry);
});

test('an accepted original without a live lease completes without reacquiring raw proofs',async t=>{
  const f=await fixture(t),entry=await f.seed({hold:false});
  for(const proof of entry.proofs)f.objects.releaseProof(proof.token);
  const before=f.snapshot();f.sealReads();
  assert.deepEqual(await f.histories.cancelCandidateReview(entry.commandId,f.auth),{protocolVersion:1,commandId:entry.commandId,status:'completed'});
  inventory(f,0);assert.deepEqual(f.snapshot(),before);
});

test('document lifecycle releases only matching held leases synchronously and preserves adoption ownership',async t=>{
  const f=await fixture(t),first=await f.seed(),second=await f.seed(),other=await f.seed({documentId:'document_2'}),adoption=await f.seed();
  const taken=f.histories.encodedReviewProofs.take(adoption.binding),before=f.snapshot();f.sealReads();
  assert.equal(f.histories.discardEncodedReviewDocument('document_1'),undefined,'Cleanup is synchronous');
  assert.deepEqual(f.histories.encodedReviewProofInventory(),{leases:1,proofs:2,metadataBytes:2*PROOF_METADATA_BYTES});
  assert.equal(f.objects.proofInventory().retained,4);released(f,first);released(f,second);live(f,other);live(f,adoption);
  f.histories.discardEncodedReviewDocument('document_1');live(f,other);live(f,adoption);assert.deepEqual(f.snapshot(),before);
  f.histories.discardEncodedReviewDocument('document_2');assert.deepEqual(f.histories.encodedReviewProofInventory(),emptyLeases);released(f,other);live(f,adoption);
  for(const proof of taken)f.objects.releaseProof(proof.token);
  assert.deepEqual(f.objects.proofInventory(),emptyProofs);
});

test('session lifecycle releases its held leases across documents synchronously and preserves other owners',async t=>{
  const f=await fixture(t),first=await f.seed(),second=await f.seed({documentId:'document_2'});
  const other=await f.seed({owner:{...f.auth,sessionHash:'b'.repeat(64)}}),adoption=await f.seed({documentId:'document_3'});
  const taken=f.histories.encodedReviewProofs.take(adoption.binding),before=f.snapshot();f.sealReads();
  assert.equal(f.histories.discardEncodedReviewSession(f.auth.sessionHash),undefined,'Cleanup is synchronous');
  assert.deepEqual(f.histories.encodedReviewProofInventory(),{leases:1,proofs:2,metadataBytes:2*PROOF_METADATA_BYTES});
  assert.equal(f.objects.proofInventory().retained,4);released(f,first);released(f,second);live(f,other);live(f,adoption);
  f.histories.discardEncodedReviewSession(f.auth.sessionHash);live(f,other);live(f,adoption);assert.deepEqual(f.snapshot(),before);
  f.histories.discardEncodedReviewSession(other.binding.sessionHash);assert.deepEqual(f.histories.encodedReviewProofInventory(),emptyLeases);released(f,other);live(f,adoption);
  for(const proof of taken)f.objects.releaseProof(proof.token);
  assert.deepEqual(f.objects.proofInventory(),emptyProofs);
});

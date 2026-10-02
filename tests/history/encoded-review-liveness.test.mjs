import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {EncodedReviewProofLeases} from '../../dist/local/server/storage/encoded-review-proofs.js';
import {Histories} from '../../dist/local/server/storage/history.js';
import {Objects,PROOF_METADATA_BYTES} from '../../dist/local/server/storage/objects.js';
import {canonical,hashBytes,parseCommand} from '../../dist/local/server/storage/canonical.js';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {candidatePlacementReview} from '../../dist/local/src/protocol/candidate-placement-review.js';
import {PIPELINE} from '../../dist/local/server/raster/profile-registry.js';

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
    CREATE TABLE candidate_document_tombstones (document_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE history_preparations (id TEXT PRIMARY KEY,hash TEXT NOT NULL,original TEXT NOT NULL,canonical TEXT NOT NULL,operation_id TEXT NOT NULL,phase TEXT NOT NULL,frozen TEXT NOT NULL) STRICT;
    CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
    INSERT INTO meta VALUES ('writerEpoch','7');
    CREATE TABLE commands (id TEXT PRIMARY KEY,hash TEXT NOT NULL,original TEXT NOT NULL,canonical TEXT NOT NULL,receipt TEXT NOT NULL) STRICT;
    CREATE TABLE client_bindings (cookie_hash TEXT PRIMARY KEY,client_id TEXT NOT NULL,expires TEXT NOT NULL) STRICT;
    CREATE TABLE events_v2 (seq TEXT PRIMARY KEY,transaction_id TEXT NOT NULL,command_id TEXT NOT NULL,json TEXT NOT NULL) STRICT;
    CREATE TABLE image_edit_reviews (id TEXT PRIMARY KEY,json TEXT NOT NULL,session_hash TEXT NOT NULL,epoch TEXT NOT NULL) STRICT;
  `);
  const objects=new Objects(root,()=>{},fail('Objects barrier'));
  const documents=new Map(),candidateChecks=[];
  const histories=new Histories(db,objects,unused('assets'),unused('rasters'),unused('ui'),unused('texts'),{checkAdoption(identity){candidateChecks.push(identity);}},
    ()=>{},fail('history barrier'),fail('commit: an accepted receipt is immutable'),id=>documents.get(id)??null,fail('register'));
  let monotonic=0;const timers=new Set();
  histories.encodedReviewProofs=new EncodedReviewProofLeases(objects,{monotonicNow:()=>monotonic,schedule(callback,delay){const timer={callback,at:monotonic+delay,unref(){return this;}};timers.add(timer);return timer;},cancel(timer){timers.delete(timer);}});
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
    documents.set(documentId,{id:documentId,revision:'3'});
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
    const conversion={encodedWidth:1,encodedHeight:1,orientation:1,profile:'untagged-srgb',profileHash:null,colorChanged:false,orientationChanged:false,resized:false};
    // RasterInfo always describes RGBA display pixels, even for a mask. Its
    // separately typed coverage below retains the second real R16 proof.
    const info=role=>({schemaVersion:role==='mask'?2:1,pipeline:PIPELINE,width:1,height:1,manifest:metadata({pixels:rgba}),pixels:rgba,pixelIdentity:hashBytes(canonical(rgba)),role,sourceAssetIds:[],conversion:role==='native'?conversion:null});
    const encodedIdentity=(assetId,encoding,assetHash=hashBytes(assetId))=>({assetId,assetVersion:'1',assetHash,info:info('native'),encoding,encoded:ref('encoded '+assetId,'image/png'),encodedAssetId:encoding==='canonical-png'?assetId:assetId+'_encoded'});
    const encodedMask={encoded:ref('encoded mask '+index,'application/x-ideogram-r16le-deflate'),pixels:mask,width:1,height:1,codec:'r16le-deflate-v1'};
    const identity={candidateId:placement.candidateId,candidateVersion:'1',documentId,jobId:'job_'+index,attemptId:'attempt_'+index,requestId:'request_'+index,
      outputIdentity:hashBytes('output '+index),preparedAssetId:'prepared_'+index,preparedAssetVersion:'1',preparedAssetHash:hashBytes('prepared '+index),requestHash:hashBytes('request '+index),jobVersion:'1',writerEpoch:'7'};
    const plan={kind:'request-raster-plan-1',kernel:'cp1-identity-grid-v1',reconstructionHalo:0,document:{width:1,height:1},domain:{x:0,y:0,width:1,height:1},
      expectedOutput:{width:1,height:1},sourcePixels:rgba,authoredMask:mask,effectiveMask:mask,dependenciesHash:hashBytes('dependencies '+index),resolution:'already-contained',approvalId:'approval_'+index,sourceToRequest:[1,0,0,1,0,0]};
    const content={protocolVersion:1,kind:'candidate-placement-review-1',reviewId,targetClientId:owner.clientId,expiresAt:new Date(now+60_000).toISOString(),documentId,documentRevision:'3',source,placement,
      inputs:{kind:'candidate-adoption-inputs-1',mode:'safe-region',identity,plan,sourceCapture:{schemaVersion:1,documentId,documentRevision:'3',image:source,scope:'visible-document',layerIds:['source_layer_'+index]},outputMapping:null,coverage:{originalEffectivePixels:1,effectivePixels:1,lostPixels:0},
        encodedRebuild:{kind:'encoded-adoption-inputs-1',source:encodedIdentity(source.compositeAssetId,'canonical-png'),candidate:encodedIdentity(identity.preparedAssetId,'candidate-original',identity.preparedAssetHash),
          mask:{assetId:'mask_'+index,assetVersion:'1',assetHash:hashBytes('mask '+index),info:info('mask'),authored:encodedMask,effective:encodedMask,approved:encodedMask}}},
      preparation:'deferred',width:1,height:1};
    const review={...content,reviewHash:hashBytes(canonical(content))};
    assert.doesNotThrow(()=>candidatePlacementReview(review),'Seed structurally valid review metadata before exercising proof-lease ownership');
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
  return {db,objects,histories,auth,bind,seed,snapshot,documents,candidateChecks,advance:milliseconds=>{monotonic+=milliseconds;},timers,sealReads:()=>{forbidReads=true;}};
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

test('only the public live review read renews genuine held proofs without reading raw content',async t=>{
 const f=await fixture(t),entry=await f.seed(),before=f.snapshot();f.sealReads();
 assert.equal([...f.timers][0].at,4000);f.advance(3000);
 assert.deepEqual(f.histories.review(entry.reviewId,f.auth),entry.review);assert.equal([...f.timers][0].at,4000,'Internal acceptance metadata checks do not renew');
 assert.deepEqual(f.histories.liveReview(entry.reviewId,f.auth),entry.review);assert.equal([...f.timers][0].at,7000);assert.equal(f.timers.size,1);
 inventory(f,1);live(f,entry);assert.deepEqual(f.snapshot(),before);assert.equal(f.candidateChecks.length,1);
});

test('an expired public review read cannot revive proof authority even before its timer is dispatched',async t=>{
 const f=await fixture(t),entry=await f.seed();f.sealReads();f.advance(4000);
 assert.throws(()=>f.histories.liveReview(entry.reviewId,f.auth),{code:'STALE_REVISION',reason:'ENCODED_REBUILD_REVIEW_REQUIRED'});
 inventory(f,0);released(f,entry);assert.equal(f.timers.size,0);
 assert.throws(()=>f.histories.liveReview(entry.reviewId,f.auth),{code:'STALE_REVISION'});inventory(f,0);
});

test('another client, session or expired binding cannot renew or release another visible owner',async t=>{
 for(const patch of [{clientId:'other_client'},{sessionHash:'b'.repeat(64)},{expires:0}])await t.test(JSON.stringify(patch),async t=>{
  const f=await fixture(t),entry=await f.seed();f.sealReads();f.advance(3000);
  assert.throws(()=>f.histories.liveReview(entry.reviewId,{...f.auth,...patch}));inventory(f,1);live(f,entry);assert.equal([...f.timers][0].at,4000);
 });
});

test('stale source revision and durable deletion reject renewal and release that held owner',async t=>{
 for(const kind of ['revision','deletion'])await t.test(kind,async t=>{
  const f=await fixture(t),entry=await f.seed();f.sealReads();
  if(kind==='revision')f.documents.get(entry.review.documentId).revision='4';else f.db.prepare('INSERT INTO candidate_document_tombstones VALUES (?)').run(entry.review.documentId);
  assert.throws(()=>f.histories.liveReview(entry.reviewId,f.auth),{code:'STALE_REVISION'});inventory(f,0);released(f,entry);assert.equal(f.timers.size,0);
 });
});

function consumedAcceptance(f,entry){
 const taken=f.histories.encodedReviewProofs.take(entry.binding),request=structuredClone(entry.request),id='accept_command';
 Object.assign(request.command,{commandId:id,transactionId:'accept_transaction',correlationId:'accept_correlation',body:{type:'AdoptReviewedCandidate',reviewId:entry.reviewId,reviewHash:entry.review.reviewHash,draft:null}});
 const original=canonical(request);assert.deepEqual(parseCommand(Buffer.from(original)),request);
 f.db.prepare('INSERT INTO history_preparations VALUES (?,?,?,?,?,?,?)').run(id,hashBytes(original),original,original,'accept_operation','preparing','null');
 f.histories.authorities.set(id,{auth:{...f.auth},started:performance.now()});f.histories.runningId=id;
 // Seed the exact association only after an actual take with real Objects
 // tokens. Real take placement is additionally exercised by acceptance tests.
 f.histories.encodedAcceptances.set(entry.reviewId,{binding:{...entry.binding},commandId:id});
 return {taken,id,request};
}

test('public reads observe an actual current acceptance without renewing or recreating consumed proof ownership',async t=>{
 const f=await fixture(t),entry=await f.seed(),active=consumedAcceptance(f,entry);f.sealReads();f.advance(10000);
 assert.deepEqual(f.histories.liveReview(entry.reviewId,f.auth),entry.review);
 assert.deepEqual(f.histories.encodedReviewProofInventory(),emptyLeases);assert.equal(f.timers.size,0);live(f,entry);
 for(const proof of active.taken)f.objects.releaseProof(proof.token);f.histories.encodedAcceptances.delete(entry.reviewId);f.histories.runningId=undefined;
 inventory(f,0);assert.throws(()=>f.histories.liveReview(entry.reviewId,f.auth),{code:'STALE_REVISION'});
});

test('queued admission or a stale association cannot claim that an acceptance consumed proof ownership',async t=>{
 for(const kind of ['not-running','missing-pending','wrong-review','wrong-session','terminal'])await t.test(kind,async t=>{
  const f=await fixture(t),entry=await f.seed(),active=consumedAcceptance(f,entry);f.sealReads();
  if(kind==='not-running')f.histories.runningId=undefined;
  if(kind==='missing-pending')f.db.prepare('DELETE FROM history_preparations WHERE id=?').run(active.id);
  if(kind==='wrong-review')f.histories.encodedAcceptances.get(entry.reviewId).binding.reviewHash=hashBytes('other');
  if(kind==='wrong-session')f.histories.authorities.get(active.id).auth.sessionHash='b'.repeat(64);
  if(kind==='terminal'){
   const original=canonical(active.request),receipt={status:'accepted',commandId:active.id,fromSeq:'2',toSeq:'4',documentRevision:'4',transactionId:active.request.command.transactionId};
   f.db.prepare('INSERT INTO commands VALUES (?,?,?,?,?)').run(active.id,hashBytes(original),original,original,canonical(receipt));
  }
  assert.throws(()=>f.histories.liveReview(entry.reviewId,f.auth));assert.equal(f.timers.size,0);live(f,entry);
  for(const proof of active.taken)f.objects.releaseProof(proof.token);f.histories.encodedAcceptances.delete(entry.reviewId);f.histories.runningId=undefined;inventory(f,0);
 });
});

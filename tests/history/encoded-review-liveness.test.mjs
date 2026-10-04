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
  for(const method of ['prove','verify','verifyOwned','readRange','adoptFile']){
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


// Exact-row validation memo controls. These call the real Histories reader,
// SQLite rows, schema/hash validator and producer accounting. The transparent
// validator wrapper measures skipped work without substituting validation.
import {adapterResources} from '../../dist/local/server/observability/adapter-resources.js';

function reviewValidationProbe(t,f){
  const original=f.histories.validateReviewMetadata;let calls=0;
  f.histories.validateReviewMetadata=function(...args){calls++;return Reflect.apply(original,this,args);};
  t.after(()=>{f.histories.validateReviewMetadata=original;});
  return ()=>calls;
}
function reviewMemoBytes(){
  return adapterResources.snapshot().groups.filter(group=>group.owner==='history'&&group.kind==='placement-review-validation').reduce((sum,group)=>sum+group.reservedBytes,0);
}
const storedReview=(f,entry)=>String(f.db.prepare('SELECT json FROM image_edit_reviews WHERE id=?').get(entry.reviewId).json);
const replaceStoredReview=(f,entry,json)=>f.db.prepare('UPDATE image_edit_reviews SET json=? WHERE id=?').run(json,entry.reviewId);
function pendingReviewAcceptance(f,entry,id='memo_acceptance'){
  const request=structuredClone(entry.request);
  Object.assign(request.command,{commandId:id,transactionId:id+'_transaction',correlationId:id+'_correlation',body:{type:'AdoptReviewedCandidate',reviewId:entry.reviewId,reviewHash:entry.review.reviewHash,draft:null}});
  const original=canonical(request);assert.deepEqual(parseCommand(Buffer.from(original)),request);
  f.db.prepare('INSERT INTO history_preparations VALUES (?,?,?,?,?,?,?)').run(id,hashBytes(original),original,original,id+'_operation','preparing','null');
  f.histories.authorities.set(id,{auth:{...f.auth},started:performance.now()});
  return request;
}

test('one exact review memo returns fresh graphs while public reads still validate and held proofs never renew',async t=>{
  const f=await fixture(t),entry=await f.seed(),calls=reviewValidationProbe(t,f),baseline=reviewMemoBytes(),before=f.snapshot(),memo=f.histories.placementReviewValidation();
  try{
    assert.equal(reviewMemoBytes(),baseline);
    const first=memo.read(entry.reviewId,f.auth);assert.deepEqual(first,entry.review);assert.equal(calls(),1);
    const booked=storedReview(f,entry).length*2+256;assert.equal(reviewMemoBytes(),baseline+booked);
    first.placement.name='Caller-owned mutation';first.inputs.identity.candidateVersion='99';
    f.advance(3000);
    const second=memo.read(entry.reviewId,f.auth);assert.deepEqual(second,entry.review);assert.notEqual(second,first);assert.notEqual(second.inputs,first.inputs);assert.equal(calls(),1);
    assert.deepEqual(f.histories.review(entry.reviewId,f.auth),entry.review);assert.equal(calls(),2,'Public authenticated review path cannot acquire memo authority');
    assert.equal([...f.timers][0].at,4000);inventory(f,1);live(f,entry);assert.deepEqual(f.snapshot(),before);
    assert.equal(reviewMemoBytes(),baseline+booked);
  }finally{memo.dispose();}
  assert.equal(reviewMemoBytes(),baseline);memo.dispose();assert.equal(reviewMemoBytes(),baseline);
});

for(const kind of ['schema','hash','json'])test('invalid first '+kind+' review cannot arm or later rearm a memo',async t=>{
  const f=await fixture(t),entry=await f.seed(),calls=reviewValidationProbe(t,f),baseline=reviewMemoBytes(),original=storedReview(f,entry),memo=f.histories.placementReviewValidation();
  try{
    const bad=structuredClone(entry.review);if(kind==='schema')bad.width=0;if(kind==='hash')bad.reviewHash='sha256:'+'0'.repeat(64);
    replaceStoredReview(f,entry,kind==='json'?'{':canonical(bad));
    assert.throws(()=>memo.read(entry.reviewId,f.auth),kind==='json'?SyntaxError:{code:'CORRUPT_STORE'});
    assert.equal(reviewMemoBytes(),baseline);
    replaceStoredReview(f,entry,original);const previous=calls();
    assert.deepEqual(memo.read(entry.reviewId,f.auth),entry.review);assert.deepEqual(memo.read(entry.reviewId,f.auth),entry.review);
    assert.equal(calls(),previous+2,'Repair after failed first validation must use the original full path for every read');
    assert.equal(reviewMemoBytes(),baseline);
  }finally{replaceStoredReview(f,entry,original);memo.dispose();}
});

for(const kind of ['changed-valid','changed-hash','different-wire','missing'])test('an observed '+kind+' review row permanently retires exact-row reuse across a real proof await',async t=>{
  const f=await fixture(t),entry=await f.seed(),calls=reviewValidationProbe(t,f),baseline=reviewMemoBytes(),original=storedReview(f,entry),memo=f.histories.placementReviewValidation();let proof;
  try{
    memo.read(entry.reviewId,f.auth);assert.equal(calls(),1);assert(reviewMemoBytes()>baseline);
    proof=await f.objects.prove(entry.proofs[0].ref,()=>{});assert.doesNotThrow(()=>f.objects.proven(entry.proofs[0].ref,proof));
    if(kind==='missing')f.db.prepare('DELETE FROM image_edit_reviews WHERE id=?').run(entry.reviewId);
    else if(kind==='different-wire')replaceStoredReview(f,entry,' '+original);
    else{const changed=structuredClone(entry.review);changed.placement.name+=' changed';if(kind==='changed-valid'){const {reviewHash,...content}=changed;changed.reviewHash=hashBytes(canonical(content));}replaceStoredReview(f,entry,canonical(changed));}
    if(kind==='missing')assert.throws(()=>memo.read(entry.reviewId,f.auth),{code:'NOT_FOUND'});
    else if(kind==='changed-hash')assert.throws(()=>memo.read(entry.reviewId,f.auth),{code:'CORRUPT_STORE'});
    else{const value=memo.read(entry.reviewId,f.auth);assert.equal(value.placement.name,entry.review.placement.name+(kind==='changed-valid'?' changed':''));}
    assert.equal(reviewMemoBytes(),baseline);
    f.db.prepare('INSERT OR REPLACE INTO image_edit_reviews VALUES (?,?,?,?)').run(entry.reviewId,original,f.auth.sessionHash,'7');
    const previous=calls();assert.deepEqual(memo.read(entry.reviewId,f.auth),entry.review);assert.deepEqual(memo.read(entry.reviewId,f.auth),entry.review);
    assert.equal(calls(),previous+2,'Restoring identical prior bytes does not rearm an invocation that observed a change');assert.equal(reviewMemoBytes(),baseline);
  }finally{if(proof)f.objects.releaseProof(proof);f.db.prepare('INSERT OR REPLACE INTO image_edit_reviews VALUES (?,?,?,?)').run(entry.reviewId,original,f.auth.sessionHash,'7');memo.dispose();}
  inventory(f,1);live(f,entry);
});

for(const kind of ['owner','session','epoch','expiry'])test('a warm exact review memo still checks live '+kind+' and releases on refusal',async t=>{
  const f=await fixture(t),entry=await f.seed(),calls=reviewValidationProbe(t,f),baseline=reviewMemoBytes(),memo=f.histories.placementReviewValidation();
  try{
    memo.read(entry.reviewId,f.auth);assert.equal(calls(),1);let auth=f.auth;
    if(kind==='owner')auth={...auth,clientId:'different_client'};
    if(kind==='session')f.db.prepare('UPDATE image_edit_reviews SET session_hash=? WHERE id=?').run('b'.repeat(64),entry.reviewId);
    if(kind==='epoch')f.db.prepare("UPDATE meta SET value='8' WHERE key='writerEpoch'").run();
    if(kind==='expiry')auth={...auth,now:Date.parse(entry.review.expiresAt)};
    assert.throws(()=>memo.read(entry.reviewId,auth),{code:kind==='owner'?'OWNER_REQUIRED':'REVIEW_EXPIRED'});
    assert.equal(calls(),1,'A memo hit still runs the original live checks');assert.equal(reviewMemoBytes(),baseline);
    f.db.prepare('UPDATE image_edit_reviews SET session_hash=? WHERE id=?').run(f.auth.sessionHash,entry.reviewId);f.db.prepare("UPDATE meta SET value='7' WHERE key='writerEpoch'").run();
    memo.read(entry.reviewId,f.auth);memo.read(entry.reviewId,f.auth);assert.equal(calls(),3);assert.equal(reviewMemoBytes(),baseline);
    inventory(f,1);live(f,entry);
  }finally{memo.dispose();}
});

for(const kind of ['binding-deleted','binding-client','binding-expiry','authority-expiry'])test('approved placement refreshes '+kind+' before consulting an already warm memo',async t=>{
  const f=await fixture(t),entry=await f.seed(),request=pendingReviewAcceptance(f,entry),calls=reviewValidationProbe(t,f),memo=f.histories.placementReviewValidation(),baseline=reviewMemoBytes();
  const originalDocument=f.histories.document,afterReview=new Error('reached unchanged document boundary');let documentCalls=0;
  // This sentinel is after real authority, SQLite review and command-hash checks.
  // It deliberately does not stand in for successful full placement validation.
  f.histories.document=()=>{documentCalls++;throw afterReview;};
  try{
    assert.throws(()=>f.histories.approvedPlacement(request.command,undefined,memo),error=>error===afterReview);
    assert.throws(()=>f.histories.approvedPlacement(request.command,undefined,memo),error=>error===afterReview);assert.equal(calls(),1);assert.equal(documentCalls,2);
    if(kind==='binding-deleted')f.db.prepare('DELETE FROM client_bindings WHERE cookie_hash=?').run(f.auth.sessionHash);
    if(kind==='binding-client')f.db.prepare('UPDATE client_bindings SET client_id=? WHERE cookie_hash=?').run('other_client',f.auth.sessionHash);
    if(kind==='binding-expiry')f.db.prepare("UPDATE client_bindings SET expires='0' WHERE cookie_hash=?").run(f.auth.sessionHash);
    if(kind==='authority-expiry')f.histories.authorities.get(request.command.commandId).started=performance.now()-120001;
    assert.throws(()=>f.histories.approvedPlacement(request.command,undefined,memo),{code:'INVALID_INPUT',reason:'IMAGE_REVIEW_EXPIRED'});
    assert.equal(documentCalls,2);assert.equal(calls(),1);inventory(f,1);live(f,entry);
  }finally{f.histories.document=originalDocument;memo.dispose();}
  assert.equal(reviewMemoBytes(),baseline);
});

test('disposed readers and separate invocations never inherit a prior successful review validation',async t=>{
  const f=await fixture(t),entry=await f.seed(),calls=reviewValidationProbe(t,f),baseline=reviewMemoBytes(),one=f.histories.placementReviewValidation(),two=f.histories.placementReviewValidation();
  try{
    one.read(entry.reviewId,f.auth);assert.equal(calls(),1);const booked=storedReview(f,entry).length*2+256;
    two.read(entry.reviewId,f.auth);assert.equal(calls(),2);assert.equal(reviewMemoBytes(),baseline+2*booked,'Each independently live invocation owns its own bounded string');
    one.read(entry.reviewId,f.auth);two.read(entry.reviewId,f.auth);assert.equal(calls(),2);
    one.dispose();assert.equal(reviewMemoBytes(),baseline+booked);one.read(entry.reviewId,f.auth);one.read(entry.reviewId,f.auth);assert.equal(calls(),4);assert.equal(reviewMemoBytes(),baseline+booked);
    two.read(entry.reviewId,f.auth);assert.equal(calls(),4);two.dispose();assert.equal(reviewMemoBytes(),baseline);
    const three=f.histories.placementReviewValidation();try{three.read(entry.reviewId,f.auth);assert.equal(calls(),5);}finally{three.dispose();}
  }finally{one.dispose();two.dispose();}
  assert.equal(reviewMemoBytes(),baseline);
});

for(const bytes of [65536,65537])test('stored review wire of '+bytes+' UTF-8 bytes preserves validation and bounded memo eligibility',async t=>{
  const f=await fixture(t),entry=await f.seed(),calls=reviewValidationProbe(t,f),baseline=reviewMemoBytes(),original=storedReview(f,entry),memo=f.histories.placementReviewValidation();
  assert(Buffer.byteLength(original)<65536);const padded=' '.repeat(bytes-Buffer.byteLength(original))+original;assert.equal(Buffer.byteLength(padded),bytes);
  try{
    replaceStoredReview(f,entry,padded);assert.deepEqual(f.histories.review(entry.reviewId,f.auth),entry.review);assert.equal(calls(),1,'Existing reader accepts whitespace-bearing legacy metadata');
    assert.deepEqual(memo.read(entry.reviewId,f.auth),entry.review);assert.deepEqual(memo.read(entry.reviewId,f.auth),entry.review);
    assert.equal(calls(),bytes===65536?2:3);assert.equal(reviewMemoBytes(),baseline+(bytes===65536?padded.length*2+256:0));
    if(bytes>65536){replaceStoredReview(f,entry,original);memo.read(entry.reviewId,f.auth);memo.read(entry.reviewId,f.auth);assert.equal(calls(),5,'Oversized first row does not arm after later shrink');assert.equal(reviewMemoBytes(),baseline);}
  }finally{replaceStoredReview(f,entry,original);memo.dispose();}
  assert.equal(reviewMemoBytes(),baseline);
});

test('review memo books conservative UTF-16 backing without retaining parsed caller graphs',async t=>{
  const f=await fixture(t),entry=await f.seed(),baseline=reviewMemoBytes();updateReview(f,entry,review=>{review.placement.name='M\u00e9mo \ud83d\ude00';});
  const json=storedReview(f,entry);assert.notEqual(Buffer.byteLength(json),json.length);
  const memo=f.histories.placementReviewValidation();try{const value=memo.read(entry.reviewId,f.auth);assert.equal(reviewMemoBytes(),baseline+json.length*2+256);value.placement.name='external mutation';assert.equal(memo.read(entry.reviewId,f.auth).placement.name,entry.review.placement.name);}finally{memo.dispose();}
  assert.equal(reviewMemoBytes(),baseline);
});

test('actual prepare failure disposes its memo before original proof-lease cleanup and never transfers it to a retry',async t=>{
  const f=await fixture(t),entry=await f.seed(),request=pendingReviewAcceptance(f,entry),baseline=reviewMemoBytes(),factory=f.histories.placementReviewValidation,documentLookup=f.histories.document,originalCommit=f.histories.commit,originalDiscard=f.histories.encodedReviewProofs.discard;
  let factories=0,disposals=0,documentCalls=0,cleanups=0;const created=[],rejections=[];
  f.histories.placementReviewValidation=function(){factories++;const owner=Reflect.apply(factory,this,[]);created.push(owner);return {read:(...args)=>owner.read(...args),dispose(){disposals++;owner.dispose();}};};
  // The original prepare reaches this live document lookup after successful
  // metadata validation. Its original error classification and finally run.
  f.histories.document=()=>{documentCalls++;assert(reviewMemoBytes()>baseline);throw Object.assign(new Error('missing fixture document dependency'),{code:'MISSING_OBJECT'});};
  f.histories.commit=(_bytes,build)=>{try{build();assert.fail('Expected the original dependency rejection');}catch(error){assert.equal(error.code,'MISSING_ASSET');assert.equal(error.reason,'HISTORY_DEPENDENCY_UNAVAILABLE');rejections.push(error);}return {status:'rejected'};};
  f.histories.encodedReviewProofs.discard=function(...args){cleanups++;assert.equal(reviewMemoBytes(),baseline,'Invocation ownership ends before the existing proof-lease drain');return Reflect.apply(originalDiscard,this,args);};
  try{
    await f.histories.prepare(request.command.commandId,'unused_fixture_slot');assert.equal(factories,1);assert.equal(disposals,1);assert.equal(documentCalls,1);assert.equal(rejections.length,1);assert.equal(cleanups,1);assert.equal(reviewMemoBytes(),baseline);inventory(f,0);released(f,entry);
    await f.histories.prepare(request.command.commandId,'unused_fixture_slot');assert.equal(factories,2);assert.equal(disposals,2);assert.equal(documentCalls,2);assert.equal(rejections.length,2);assert.equal(cleanups,2);assert.equal(reviewMemoBytes(),baseline);assert.notEqual(created[0],created[1]);
    const calls=reviewValidationProbe(t,f);for(const owner of created){owner.read(entry.reviewId,f.auth);owner.read(entry.reviewId,f.auth);}assert.equal(calls(),4,'Both disposed invocation readers remain full-validation fallbacks');assert.equal(reviewMemoBytes(),baseline);
  }finally{f.histories.placementReviewValidation=factory;f.histories.document=documentLookup;f.histories.commit=originalCommit;f.histories.encodedReviewProofs.discard=originalDiscard;for(const owner of created)owner.dispose();}
});


// The real bounded history metadata owner retains parsed-value admission while
// the new verified byte owner ends synchronously. No raster/native work is used.
import {CompositionMemory as PlacementMetadataMemory} from '../../dist/local/server/storage/composition-memory.js';
const placementReadSnapshot=()=>{const value=adapterResources.snapshot();return {backingBytes:value.backingBytes,reservedBytes:value.reservedBytes,activeLeases:value.activeLeases,returnedBuffers:value.returnedBuffers,unscopedReturnedBuffers:value.unscopedReturnedBuffers,droppedTransitions:value.droppedTransitions};};
function assertPlacementRawDrained(before,borrowers=0){assert.deepEqual(placementReadSnapshot(),{...before,activeLeases:before.activeLeases+borrowers},'Only the original parsed-admission borrower handles remain; raw verified backing has drained');}
async function placementMetadataFixture(t){
 const f=await fixture(t),originalRasters=f.histories.rasters;let rss=0;
 const memory=new PlacementMetadataMemory(()=>0,()=>rss),rows=[];f.histories.rasters={compositionMemory:memory};t.after(()=>{f.histories.rasters=originalRasters;});
 for(const method of ['verifyOwned','verify','readRangeOwned']){const original=f.objects[method];t.mock.method(f.objects,method,function(...args){const row={method,returned:false,releases:0};rows.push(row);const result=Reflect.apply(original,this,args);row.returned=true;if(method==='verify')return result;return {bytes:result.bytes,release(){row.releases++;result.release();}};});}
 return {...f,memory,rows,setRSS:value=>{rss=value;},async put(bytes,mediaType='application/json'){const value=ref(bytes,mediaType),path=f.objects.path(value);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600});return {ref:value,path};}};
}

test('history small metadata returns a fresh parsed owner after verified bytes release, then closes parsed admission explicitly',async t=>{
 const f=await placementMetadataFixture(t),bytes=Buffer.from(canonical({nested:{value:1}})),{ref:input}=await f.put(bytes),before=placementReadSnapshot();let first,second;
 try{
  first=f.histories.ownPlacementMetadata(input,65536);assert.deepEqual(first.value,{nested:{value:1}});assert.equal(f.memory.resourceOwnership().borrowers,1);assert.equal(f.memory.bytes,bytes.length*12+1024**2);
  assert.deepEqual(f.rows.map(row=>[row.method,row.returned,row.releases]),[['verifyOwned',true,1]]);assertPlacementRawDrained(before,1);
  first.value.nested.value=2;second=f.histories.ownPlacementMetadata(input,65536);assert.deepEqual(second.value,{nested:{value:1}});assert.notEqual(second.value,first.value);assert.equal(f.memory.resourceOwnership().borrowers,2);
  await Promise.resolve();assert.deepEqual(second.value,{nested:{value:1}});first.release();assert.equal(f.memory.resourceOwnership().borrowers,1);assert.throws(()=>first.value,{code:'CLOSED'});first.release();assert.equal(f.memory.resourceOwnership().borrowers,1);
 }finally{first?.release();second?.release();}
 assert.equal(f.memory.bytes,0);assert.equal(f.memory.resourceOwnership().borrowers,0);assert.deepEqual(placementReadSnapshot(),before);
});

for(const [name,bytes]of [['syntax',Buffer.from('{')],['duplicate',Buffer.from('{"a":1,"a":2}')],['noncanonical',Buffer.from('{ "value": 1 }')],['invalid-utf8',Buffer.from([0xff])]])test('history small metadata '+name+' refusal releases verified bytes and original parsed admission',async t=>{
 const f=await placementMetadataFixture(t),{ref:input}=await f.put(bytes),before=placementReadSnapshot();assert.throws(()=>f.histories.ownPlacementMetadata(input,65536),{code:'CORRUPT_OBJECT'});
 assert.deepEqual(f.rows.map(row=>[row.method,row.returned,row.releases]),[['verifyOwned',true,1]]);assert.equal(f.memory.bytes,0);assert.equal(f.memory.resourceOwnership().borrowers,0);assert.deepEqual(placementReadSnapshot(),before);
});

test('history owned metadata rechecks changed original bytes instead of reusing a prior parsed graph',async t=>{
 const f=await placementMetadataFixture(t),bytes=Buffer.from(canonical({value:1})),{ref:input,path}=await f.put(bytes),before=placementReadSnapshot();const owner=f.histories.ownPlacementMetadata(input,65536);
 try{
  await writeFile(path,Buffer.from(canonical({value:2})),{mode:0o600});assert.throws(()=>f.histories.ownPlacementMetadata(input,65536),{code:'CORRUPT_OBJECT'});assert.equal(f.memory.resourceOwnership().borrowers,1,'Failed fresh read cannot consume or leak the prior owner');assert.deepEqual(owner.value,{value:1});
  await writeFile(path,bytes,{mode:0o600});const fresh=f.histories.ownPlacementMetadata(input,65536);try{assert.deepEqual(fresh.value,{value:1});assert.notEqual(fresh.value,owner.value);}finally{fresh.release();}
 }finally{owner.release();}assert.equal(f.memory.bytes,0);assert.deepEqual(placementReadSnapshot(),before);
});

for(const kind of ['wrong-media','empty','maximum','rss'])test('history '+kind+' metadata admission remains before owned byte I/O',async t=>{
 const f=await placementMetadataFixture(t),bytes=kind==='empty'?Buffer.alloc(0):Buffer.from(canonical({ok:true})),{ref:input}=await f.put(bytes,kind==='wrong-media'?'text/plain':'application/json'),before=placementReadSnapshot();if(kind==='rss')f.setRSS(536870912);
 assert.throws(()=>f.histories.ownPlacementMetadata(input,kind==='maximum'?bytes.length-1:65536),{code:kind==='rss'?'CAPACITY':'CORRUPT_STORE'});assert.deepEqual(f.rows,[]);assert.equal(f.memory.bytes,0);assert.equal(f.memory.resourceOwnership().borrowers,0);assert.deepEqual(placementReadSnapshot(),before);
});

for(const size of [65536,65537])test('history '+size+' byte metadata boundary preserves full verification and the larger owned-range fallback',async t=>{
 const f=await placementMetadataFixture(t),value={value:'x'.repeat(size-Buffer.byteLength(canonical({value:''})))},bytes=Buffer.from(canonical(value)),{ref:input}=await f.put(bytes),before=placementReadSnapshot();assert.equal(bytes.length,size);const owner=f.histories.ownPlacementMetadata(input,524288);
 try{assert.deepEqual(owner.value,value);assert.equal(f.memory.bytes,size*12+1024**2);assert.deepEqual(f.rows.map(row=>row.method),size===65536?['verifyOwned']:['verify','readRangeOwned']);assert(f.rows.filter(row=>row.method!=='verify').every(row=>row.releases===1));assertPlacementRawDrained(before,1);}finally{owner.release();}
 assert.equal(f.memory.bytes,0);assert.deepEqual(placementReadSnapshot(),before);
});

test('history parsed-value consumer failure releases the original admission after raw owner already ended',async t=>{
 const f=await placementMetadataFixture(t),{ref:input}=await f.put(Buffer.from(canonical({ok:true}))),before=placementReadSnapshot(),error=Error('metadata consumer failed');
 await assert.rejects((async()=>{const owner=f.histories.ownPlacementMetadata(input,65536);try{assert.equal(f.rows[0].releases,1);await Promise.resolve();assert.deepEqual(owner.value,{ok:true});throw error;}finally{owner.release();}})(),value=>value===error);
 assert.equal(f.memory.bytes,0);assert.equal(f.memory.resourceOwnership().borrowers,0);assert.deepEqual(placementReadSnapshot(),before);
});

test('history rejects changed returned metadata bytes even after genuine file verification and drains both owners',async t=>{
 const f=await placementMetadataFixture(t),bytes=Buffer.from(canonical({value:1})),{ref:input}=await f.put(bytes),before=placementReadSnapshot(),original=f.objects.verifyOwned;
 t.mock.method(f.objects,'verifyOwned',function(...args){const owner=Reflect.apply(original,this,args);assert.deepEqual(Buffer.from(owner.bytes),bytes);owner.bytes[owner.bytes.indexOf(49)]=50;return owner;});
 assert.throws(()=>f.histories.ownPlacementMetadata(input,65536),{code:'CORRUPT_OBJECT'});assert.deepEqual(f.rows.map(row=>[row.method,row.returned,row.releases]),[['verifyOwned',true,1]]);assert.equal(f.memory.bytes,0);assert.equal(f.memory.resourceOwnership().borrowers,0);assert.deepEqual(placementReadSnapshot(),before);
});


// Call the actual Histories comparison-manifest method with schema-valid local
// manifests and real Objects verification. Pixel/render authority is not mocked
// into existence: these controls cover metadata reads, not native rendering.
async function letteringReadFixture(t){
 const f=await placementMetadataFixture(t),grid={width:1,height:1},images={},graphs={},files={},values={};
 const pixels=ref(Buffer.from([0,0,0,255]),RGBA),blob=ref(Buffer.from('fixture PNG identity'),'image/png'),intent=ref(Buffer.from('fixture intent'));
 for(const [key,comparison]of [['candidateAlone','candidate-alone'],['nativeOff','native-off'],['nativeOn','native-on']]){
  const layers=[{assetId:'fixture_candidate',transform:[1,0,0,1,0,0],opacity:1,mask:null}],value={schemaVersion:1,pipeline:PIPELINE,width:1,height:1,format:'straight-srgb-rgba8',layout:'row-major-tile-views-v1',tileSize:512,pixels,tiles:[{x:0,y:0,width:1,height:1,hash:pixels.hash}],dependencies:[],plan:{kind:'candidate-lettering-comparison-v1',sourceWidth:1,sourceHeight:1,layers,comparison,kernel:'triangle-area-source-axis-row-norm-v1',edge:'transparent-zero-no-renormalization',preservation:'not-applied'}};
  const bytes=Buffer.from(canonical(value)),stored=await f.put(bytes);files[key]={...stored,bytes};values[key]=value;
  graphs[key]={type:'ComposeRaster',width:1,height:1,layers};images[key]={id:'fixture_'+key,availability:'available',safety:'safe',qualification:'canonical-png',blob,raster:{role:'export',width:1,height:1,manifest:stored.ref,pixels}};
 }
 return {...f,grid,images,graphs,files,values,intent,read(){return f.histories.letteringManifest(intent,grid,images,graphs);}};
}
function assertLetteringReadDrained(f,before,attempts,returned=attempts){
 assert.equal(f.rows.length,attempts);assert(f.rows.every(row=>row.method==='verifyOwned'));
 assert.equal(f.rows.filter(row=>row.returned).length,returned);assert(f.rows.filter(row=>row.returned).every(row=>row.releases===1));assert(f.rows.filter(row=>!row.returned).every(row=>row.releases===0));
 assert.deepEqual(placementReadSnapshot(),before,'Verified raw backing and handles must end before the surrounding producer scope');
}

test('lettering comparison reads release each verified buffer while the original producer scope stays open',async t=>{
 const f=await letteringReadFixture(t);
 await adapterResources.scope('lettering-comparison-consumer',async()=>{
  const before=placementReadSnapshot(),original=f.objects.verifyOwned;
  t.mock.method(f.objects,'verifyOwned',function(...args){assert.deepEqual(placementReadSnapshot(),before,'Prior row ownership must drain before the next read');return Reflect.apply(original,this,args);});
  const expected={kind:'candidate-lettering-comparison-manifest-1',intent:f.intent,grid:f.grid,preservation:'not-applied',images:[['candidateAlone','candidate-alone'],['nativeOff','native-off'],['nativeOn','native-on']].map(([key,comparison])=>({comparison,assetId:f.images[key].id,blob:f.images[key].blob,raster:f.images[key].raster}))};
  const first=f.read();assert.deepEqual(first,expected);assertLetteringReadDrained(f,before,3);
  await Promise.resolve();assert.deepEqual(placementReadSnapshot(),before);
  const second=f.read();assert.deepEqual(second,expected);assert.notStrictEqual(second,first);assert.notStrictEqual(second.images,first.images);assertLetteringReadDrained(f,before,6);
 });
});

test('lettering comparison parse, schema and plan refusals release the successful and failing row owners',async t=>{
 for(const kind of ['parse','schema','plan']){
  const f=await letteringReadFixture(t),value=JSON.parse(canonical(f.values.nativeOff));let bytes;
  if(kind==='parse')bytes=Buffer.from('{');else{if(kind==='schema')value.format='invalid-format';else value.plan.comparison='native-on';bytes=Buffer.from(canonical(value));}
  const stored=await f.put(bytes);f.images.nativeOff.raster.manifest=stored.ref;
  await adapterResources.scope('lettering-refused-consumer',async()=>{
   const before=placementReadSnapshot();
   assert.throws(()=>f.read(),error=>kind==='parse'?error instanceof SyntaxError:kind==='schema'?error instanceof Error&&error.message==='Invalid recovery data':error.code==='INCOMPATIBLE'&&error.reason==='LETTERING_COMPARISON_REQUIRED');
   assertLetteringReadDrained(f,before,2);await Promise.resolve();assert.deepEqual(placementReadSnapshot(),before);
  });
 }
});

test('lettering comparison preserves a comparison error identity while releasing its verified bytes',async t=>{
 const f=await letteringReadFixture(t),original=Object.freeze(Error('original comparison graph failure'));let reads=0;
 Object.defineProperty(f.graphs.nativeOff,'layers',{get(){reads++;throw original;}});
 await adapterResources.scope('lettering-graph-failure',async()=>{
  const before=placementReadSnapshot();assert.throws(()=>f.read(),error=>error===original);assert.equal(reads,1);assertLetteringReadDrained(f,before,2);assert.equal(original.message,'original comparison graph failure');
 });
});

test('lettering comparison verifies changed original bytes again and accepts a restored source without reuse',async t=>{
 const f=await letteringReadFixture(t),first=f.files.candidateAlone,corrupt=Buffer.from(first.bytes);corrupt[0]^=1;
 await adapterResources.scope('lettering-fresh-file-check',async()=>{
  const before=placementReadSnapshot(),original=f.read();assertLetteringReadDrained(f,before,3);
  await writeFile(first.path,corrupt,{mode:0o600});assert.throws(()=>f.read(),{code:'CORRUPT_OBJECT'});assertLetteringReadDrained(f,before,4,3);
  await writeFile(first.path,first.bytes,{mode:0o600});const restored=f.read();assert.deepEqual(restored,original);assert.notStrictEqual(restored,original);assertLetteringReadDrained(f,before,7,6);
 });
});

test('lettering comparison keeps the exact small-read ceiling and refuses larger metadata before an owner returns',async t=>{
 for(const size of [65536,65537]){
  const f=await letteringReadFixture(t),raw=canonical(f.values.candidateAlone),bytes=Buffer.from(raw+' '.repeat(size-Buffer.byteLength(raw))),stored=await f.put(bytes);f.images.candidateAlone.raster.manifest=stored.ref;assert.equal(bytes.length,size);
  await adapterResources.scope('lettering-read-size-bound',async()=>{
   const before=placementReadSnapshot();if(size===65536){assert.equal(f.read().images.length,3);assertLetteringReadDrained(f,before,3);}else{assert.throws(()=>f.read(),{code:'PAYLOAD_TOO_LARGE'});assertLetteringReadDrained(f,before,1,0);}
  });
 }
});

test('lettering comparison preserves asset preconditions before reading and grid rejection after all owners end',async t=>{
 const f=await letteringReadFixture(t);
 await adapterResources.scope('lettering-preconditions-and-grid',async()=>{
  const before=placementReadSnapshot();f.images.candidateAlone.qualification='opaque';
  assert.throws(()=>f.read(),{code:'INCOMPATIBLE',reason:'LETTERING_COMPARISON_REQUIRED'});assertLetteringReadDrained(f,before,0);
  f.images.candidateAlone.qualification='canonical-png';f.images.nativeOn.raster.width=2;
  assert.throws(()=>f.read(),{code:'INCOMPATIBLE',reason:'LETTERING_COMPARISON_GRID'});assertLetteringReadDrained(f,before,3);
 });
});

// Exercise the actual compiled Histories method, not a replacement algorithm.
// Its collaborator boundary is an already validated JSON state and reviewed
// decision; document/ID/limit services are explicit spies, not native proofs.
function placementCloneFixture(schemaVersion=5,{newDocument=false}={}){
 const original={id:'original',version:'7',kind:'image',name:'Original',assetId:'original_asset',layerToDocument:[1,0,0,1,3,4],opacity:0.7,visible:true,locked:false,blend:'normal',mask:null};
 const native={id:'native',version:'3',kind:'text',name:'Native',assetId:'native_asset',layerToDocument:[1,0,0,1,5,6],opacity:0.6,visible:true,locked:false,blend:'normal',mask:null,source:metadata({fixture:'native-source'})};
 const layers=schemaVersion===1?[original]:[original,native];
 // Deliberately non-default own-key order is part of the serialized state.
 const before={height:32,layers,schemaVersion,width:32,...(schemaVersion===5?{composition:{id:'composition',value:metadata({fixture:'composition'}),bindings:{authored_native:'native'}}}:{})};
 const copyState=structuredClone(before),copy={sourceLayerId:'native',newLayerId:'native_copy',sourceStateHash:hashBytes(canonical(copyState.layers[1]??{})),source:copyState.layers[1]?.source,transform:[1,0,0,1,9,10]};
 const decision={copiedNative:newDocument?[copy]:[],afterOrder:newDocument?[{id:'generated',version:'1',visible:true},{id:'native_copy',version:'1',visible:true}]:[{id:'original',version:'8',visible:false},{id:'generated',version:'1',visible:true},...(schemaVersion===1?[]:[{id:'native',version:'3',visible:true}])]};
 const body={placement:newDocument?'new-document':'current-document',newDocumentId:newDocument?'new_document':null,newLayerId:'generated',name:'Generated',textTreatment:{choice:{nativeCopies:newDocument?[{sourceLayerId:'native',newLayerId:'native_copy',transform:copy.transform}]:[]}}},document={id:'placement_document'},events=[];
 const state={used:false,existingDocument:false,tombstone:false,limitError:null};
 const histories=Object.create(Histories.prototype);
 Object.assign(histories,{document(id){events.push(['document',id]);return state.existingDocument?{id}:null;},db:{prepare(sql){assert.equal(sql,'SELECT 1 FROM candidate_document_tombstones WHERE document_id=?');return {get(id){events.push(['tombstone',id]);return state.tombstone?{found:1}:undefined;}};}},usedLayer(documentId,layerId){events.push(['usedLayer',documentId,layerId]);return state.used;},texts:{limits(after){events.push(['limits',after]);if(state.limitError)throw state.limitError;}}});
 const generated={id:'generated',version:'1',kind:'image',name:'Generated',assetId:'generated_asset',layerToDocument:[1,0,0,1,0,0],opacity:1,visible:true,locked:false,blend:'normal',mask:null};
 return {histories,before,copyState,decision,body,document,state,events,generated,run(width=32,height=32){return histories.textPlacementState(body,document,before,width,height,'generated_asset',decision,copyState);}};
}

test('actual text placement preserves current-document schema one through five values and own-key order',()=>{
 for(const version of [1,2,3,4,5]){
  const f=placementCloneFixture(version),input=structuredClone(f.before),expected=structuredClone(f.before);
  expected.layers=[{...structuredClone(f.before.layers[0]),version:'8',visible:false},f.generated,...(version===1?[]:[structuredClone(f.before.layers[1])])];
  const after=f.run();assert.deepEqual(after,expected);assert.deepEqual(Object.keys(after),Object.keys(input));assert.equal(canonical(after),canonical(expected));assert.deepEqual(f.before,input);
  assert.deepEqual(f.events.map(row=>row[0]),['usedLayer','limits']);assert.equal(f.events[1][1],after);
 }
});

test('actual current-document placement deep-isolates retained layers and schema five composition metadata',()=>{
 const f=placementCloneFixture(),original=structuredClone(f.before),copied=structuredClone(f.copyState),after=f.run();
 assert.notEqual(after.layers[0],f.before.layers[0]);assert.notEqual(after.layers[0].layerToDocument,f.before.layers[0].layerToDocument);
 assert.notEqual(after.layers[2].source,f.before.layers[1].source);assert.notEqual(after.composition,f.before.composition);assert.notEqual(after.composition.bindings,f.before.composition.bindings);
 after.layers[0].layerToDocument[4]=999;after.layers[2].source.hash='sha256:'+'f'.repeat(64);after.composition.value.byteLength='1';after.composition.bindings.authored_native='changed';
 assert.deepEqual(f.before,original);assert.deepEqual(f.copyState,copied);assert.deepEqual(f.run().composition,original.composition);
});

test('actual current-document final metadata clone excludes the discarded original layer graph',t=>{
 const f=placementCloneFixture(),clone=globalThis.structuredClone,rootInputs=[];
 t.mock.method(globalThis,'structuredClone',function(value,...args){if(value&&Object.hasOwn(value,'schemaVersion')&&Array.isArray(value.layers))rootInputs.push({keys:Object.keys(value),layers:value.layers,composition:value.composition});return Reflect.apply(clone,this,[value,...args]);});
 const after=f.run();assert.equal(rootInputs.length,1);assert.deepEqual(rootInputs[0].keys,Object.keys(f.before));assert.deepEqual(rootInputs[0].layers,[]);assert.notEqual(rootInputs[0].layers,f.before.layers);assert.equal(rootInputs[0].composition,f.before.composition);
 assert.equal(after.layers.length,3);assert.notEqual(after.composition,f.before.composition);
});

test('actual current placement retains ID mapping and schema refusal order before text limits',()=>{
 const reused=placementCloneFixture();reused.state.used=true;reused.decision.copiedNative=[{sourceLayerId:'missing'}];
 assert.throws(()=>reused.run(),{code:'INVALID_INPUT',reason:'LAYER_ID_REUSE'});assert.deepEqual(reused.events.map(row=>row[0]),['usedLayer']);
 const badCopy=placementCloneFixture();badCopy.decision.copiedNative=[{sourceLayerId:'missing'}];
 assert.throws(()=>badCopy.run(),{code:'INCOMPATIBLE',reason:'TEXT_TREATMENT_COPY_MAPPING_REQUIRED'});assert.deepEqual(badCopy.events.map(row=>row[0]),['usedLayer']);
 const missing=placementCloneFixture();missing.decision.afterOrder.push({id:'absent',version:'1',visible:true});assert.throws(()=>missing.run(),{code:'CORRUPT_OBJECT'});assert.deepEqual(missing.events.map(row=>row[0]),['usedLayer']);
 const duplicate=placementCloneFixture();duplicate.decision.afterOrder.push({id:'native',version:'3',visible:true});assert.throws(()=>duplicate.run(),{message:'Invalid recovery data'});assert.deepEqual(duplicate.events.map(row=>row[0]),['usedLayer']);
 const absent=placementCloneFixture();absent.body.textTreatment=null;assert.throws(()=>absent.run(),{code:'CORRUPT_STORE'});assert.deepEqual(absent.events,[]);
});

test('actual placement preserves the text-limit failure identity and rechecks a later invocation',()=>{
 const f=placementCloneFixture(),original=structuredClone(f.before),failure=Object.freeze(Error('original text limit refusal'));f.state.limitError=failure;
 assert.throws(()=>f.run(),error=>error===failure);assert.deepEqual(f.events.map(row=>row[0]),['usedLayer','limits']);assert.deepEqual(f.before,original);
 f.events.length=0;f.state.limitError=null;const after=f.run();assert.deepEqual(f.events.map(row=>row[0]),['usedLayer','limits']);assert.equal(f.events[1][1],after);assert.deepEqual(f.before,original);
});

test('actual new-document placement keeps its existing native-copy shape aliases and composition-null contract',()=>{
 for(const version of [2,5]){
  const f=placementCloneFixture(version,{newDocument:true}),before=structuredClone(f.before),copyBefore=structuredClone(f.copyState),after=f.run(48,64),copy=f.decision.copiedNative[0];
  const expected={schemaVersion:version,width:48,height:64,layers:[f.generated,{...structuredClone(f.copyState.layers[1]),id:'native_copy',version:'1',layerToDocument:copy.transform}],...(version===5?{composition:null}:{})};
  assert.deepEqual(after,expected);assert.deepEqual(Object.keys(after),Object.keys(expected));assert.deepEqual(f.events.map(row=>row[0]),['document','tombstone','limits']);
  assert.notEqual(after.layers[1].source,f.copyState.layers[1].source);assert.equal(after.layers[1].layerToDocument,copy.transform,'The existing reviewed-decision transform alias is preserved');
  after.layers[1].source.byteLength='1';after.layers[1].layerToDocument[4]=100;assert.deepEqual(f.before,before);assert.deepEqual(f.copyState,copyBefore);
 }
});

test('actual new-document placement preserves document reuse fresh-ID and copied-row refusal precedence',()=>{
 const existing=placementCloneFixture(5,{newDocument:true});existing.state.existingDocument=true;existing.decision.copiedNative=[{sourceLayerId:'missing'}];assert.throws(()=>existing.run(),{code:'INVALID_INPUT',reason:'DOCUMENT_ID_REUSE'});assert.deepEqual(existing.events.map(row=>row[0]),['document']);
 const tombstone=placementCloneFixture(5,{newDocument:true});tombstone.state.tombstone=true;assert.throws(()=>tombstone.run(),{code:'INVALID_INPUT',reason:'DOCUMENT_ID_REUSE'});assert.deepEqual(tombstone.events.map(row=>row[0]),['document','tombstone']);
 const reused=placementCloneFixture(5,{newDocument:true});reused.body.newLayerId='original';assert.throws(()=>reused.run(),{code:'INVALID_INPUT',reason:'TEXT_TREATMENT_FRESH_LAYER_IDS_REQUIRED'});assert.deepEqual(reused.events.map(row=>row[0]),['document','tombstone']);
 for(const change of [f=>{f.decision.copiedNative[0].sourceLayerId='missing';},f=>{f.decision.copiedNative[0].sourceStateHash=hashBytes('wrong state');},f=>{f.decision.copiedNative[0].source=metadata({wrong:'source'});}]){
  const f=placementCloneFixture(5,{newDocument:true});change(f);assert.throws(()=>f.run(),{code:'INCOMPATIBLE',reason:'TEXT_TREATMENT_COPY_MAPPING_REQUIRED'});assert.deepEqual(f.events.map(row=>row[0]),['document','tombstone']);
 }
});

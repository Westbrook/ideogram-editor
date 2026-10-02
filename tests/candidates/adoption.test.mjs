import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,chmod,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Candidates} from '../../dist/local/server/storage/candidates.js';
import {p2SemanticSchema} from '../../dist/local/server/storage/schema.js';
import {StoreError} from '../../dist/local/server/storage/errors.js';
import {canonical} from '../../dist/local/server/storage/canonical.js';
import {bindRequestMask,confirmRequestMask} from '../../dist/local/src/request/core.js';
import {createIdentityRequestPlan} from '../../dist/local/src/request/raster-plan.js';
import {PIPELINE} from '../../dist/local/server/raster/engine.js';
import {asset as validateAsset,rasterManifest as validateRasterManifest} from '../../dist/local/src/protocol/validate.js';

// Exercise the candidate storage boundary with real SQLite transactions. The
// worker is an explicit substitute; pixel preservation is covered by raster
// tests, while these checks cover what may reach that worker and be published.
function fixture(t,{width=3,height=2,metadataWidth=width,metadataHeight=height,requestWidth=width,requestHeight=height}={}) {
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE assets(id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE candidate_jobs(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE candidates(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,job_id TEXT NOT NULL,json TEXT NOT NULL);
 CREATE TABLE candidate_private(id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE candidate_journal(seq INTEGER PRIMARY KEY,family TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL);
 CREATE TABLE candidate_document_tombstones(document_id TEXT PRIMARY KEY,generation TEXT NOT NULL);
 CREATE TABLE documents(id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE queue_jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TABLE portable_rows(namespace TEXT,kind TEXT,id TEXT,json TEXT);
 CREATE TABLE roots(owner TEXT,hash TEXT);`);
 t.after(()=>db.close());
 const content=new Map(),activeProofs=new Map(),slots=new Set(),registered=[],calls=[],streams=new Map(),finished=[];
 let proofCounter=0,streamCounter=0;
 const put=(value,mediaType='application/json')=>{
  const bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:canonical(value));
  const ref={hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byteLength:String(bytes.length),mediaType};content.set(ref.hash,bytes);return ref;
 };
 const verify=ref=>{const bytes=content.get(ref.hash);if(!bytes)throw new StoreError('MISSING_OBJECT');assert.equal(String(bytes.length),ref.byteLength);return bytes;};
 const objects={verify,readRange:(ref,offset,length)=>verify(ref).subarray(Number(offset),Number(offset)+length),
  acquire:slot=>slots.add(slot),release:slot=>slots.delete(slot),unreserve:()=>{},
  begin(byteLength,mediaType,expectedHash){const id='stream_'+(++streamCounter);streams.set(id,{byteLength,mediaType,expectedHash,chunks:[]});return id;},
  chunk(id,bytes){const stream=streams.get(id);assert(stream);stream.chunks.push(Buffer.from(bytes));},
  finish(id){const stream=streams.get(id);assert(stream);const bytes=Buffer.concat(stream.chunks);assert.equal(String(bytes.length),stream.byteLength);const ref=put(bytes,stream.mediaType);if(stream.expectedHash)assert.equal(ref.hash,stream.expectedHash);streams.delete(id);finished.push(ref);return ref;},
  abort:id=>streams.delete(id),
  async prove(ref,check){check();verify(ref);const token='proof_'+(++proofCounter);activeProofs.set(token,ref);return token;},
  proven(ref,token){assert.deepEqual(activeProofs.get(token),ref);verify(ref);},releaseProof:token=>activeProofs.delete(token)};
 const saveAsset=asset=>db.prepare('INSERT INTO assets VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(asset.id,canonical(asset));
 const assets={asset(id){const row=db.prepare('SELECT json FROM assets WHERE id=?').get(id);return row?JSON.parse(row.json):null;},safeAsset(id){const asset=this.asset(id);if(!asset)throw new StoreError('NOT_FOUND');if(asset.safety!=='safe')throw new StoreError('CONTENT_WITHHELD');return asset;}};
 const raster=(id,w,h,role='native',plan=null)=>{
  const pixels=put(Buffer.alloc(w*h*4,71),'application/x-ideogram-rgba8'),conversion=role==='native'?{encodedWidth:w,encodedHeight:h,orientation:1,profile:'untagged-srgb',profileHash:null,colorChanged:false,orientationChanged:false,resized:false}:null;
  const manifest=put({width:w,height:h,pixels,plan:plan??{kind:'decoded-native',sourceAssetId:'encoded_1',conversion}});
  return {id,version:'1',purpose:'image',blob:put('png:'+id,'image/png'),dependencies:[pixels,manifest],safety:'safe',availability:'available',qualification:'canonical-raster',measuredMediaType:'image/png',raster:{schemaVersion:1,pipeline:'fixture',width:w,height:h,manifest,pixels,pixelIdentity:pixels.hash,role,sourceAssetIds:role==='native'?['encoded_1']:[],conversion}};
 };
 const original={id:'encoded_1',version:'1',purpose:'image',blob:put('encoded provider original','image/png'),dependencies:[],safety:'unknown',availability:'available',qualification:'pending-decoder',measuredMediaType:'image/png'};
 const prepared=raster('prepared_1',width,height);saveAsset(original);saveAsset(prepared);
 const document={id:'document_1',revision:'7',width:5,height:3};db.prepare('INSERT INTO documents VALUES (?,?)').run(document.id,canonical(document));
 const job={id:'job_1',version:'1',documentId:document.id,disposition:'eligible',review:{kind:'request-review-1',endpoint:'ideogram/v4',prompt:put('a prompt','text/plain'),request:{kind:'generate',settings:{count:1,seed:{kind:'provider-random'}},size:{kind:'custom',width:requestWidth,height:requestHeight}}},attempts:[{id:'attempt_1',requestId:'request_1'}]};
 const saveJob=()=>db.prepare('INSERT INTO queue_jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(job.id,canonical(job));saveJob();
 const fence={jobId:job.id,attemptId:'attempt_1',requestId:'request_1',epoch:'epoch_1',jobVersion:'1'};
 const queue={assertResult(f){if(canonical(f)!==canonical(fence))throw new StoreError('STALE_EPOCH');return job;},resultFence:()=>({...fence}),deleted:()=>false,resultTransaction(f,run){this.assertResult(f);db.exec('BEGIN IMMEDIATE');try{const result=run(job);db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
 const rasters={manifest(id){return JSON.parse(verify(assets.asset(id).raster.manifest));},async prepareDocument(body,id,slot,check,preparedInput,documentId){
  calls.push({body:structuredClone(body),id,slot,preparedInput,documentId});check();
  const asset=body.type==='PrepareCandidate'?prepared:raster(id,body.plan.document.width,body.plan.document.height,'composite');
  const proofs=[];for(const ref of [asset.blob,...asset.dependencies])proofs.push({ref,token:await objects.prove(ref,check)});
  return {asset,proofs};
 }};
 const register=(owner,ref,token)=>{if(token)objects.proven(ref,token);registered.push({owner,ref});db.prepare('INSERT INTO roots VALUES (?,?)').run(owner,ref.hash);};
 const reopen=()=>new Candidates(db,objects,assets,rasters,queue,()=>{},register),candidates=reopen();
 const candidate={id:'candidate_1',version:'4',documentId:document.id,jobId:job.id,attemptId:fence.attemptId,requestId:fence.requestId,outputIndex:0,outputIdentity:'sha256:'+'9'.repeat(64),safety:'safe',state:'prepared',hidden:false,encodedAssetId:original.id,preparedAssetId:prepared.id,warning:null};
 const saveCandidate=patch=>{Object.assign(candidate,patch);db.prepare('INSERT INTO candidates VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(candidate.id,candidate.documentId,candidate.jobId,canonical(candidate));};saveCandidate({});
 db.prepare('INSERT INTO candidate_private VALUES (?,?)').run(candidate.id,canonical({url:'http://127.0.0.1/output',expectedBytes:null,mime:'image/png',width:metadataWidth,height:metadataHeight,mediaRecord:null,retryRequested:false}));
 const readCandidate=()=>JSON.parse(db.prepare('SELECT json FROM candidates WHERE id=?').get(candidate.id).json);
 const release=result=>{for(const proof of result.proofs)objects.releaseProof(proof.token);};
 return {db,content,put,verify,objects,assets,rasters,raster,saveAsset,original,prepared,candidate,saveCandidate,readCandidate,candidates,reopen,job,saveJob,fence,document,registered,calls,activeProofs,slots,streams,finished,release};
}

function capturedRequest(f,{coverageValues=[[1,1,1],[2,1,257],[2,2,32768],[3,2,65535]]}={}) {
 const capture={schemaVersion:1,documentId:f.document.id,documentRevision:f.document.revision,image:{state:f.put({layers:[{id:'layer_1'}]}),semanticDigest:'sha256:'+'8'.repeat(64),compositeAssetId:'source_1'},scope:'single-layer',layerIds:['layer_1']};
 const sourceAsset=f.raster('source_1',5,3,'composite',{kind:'request-source-capture-v1',capture});sourceAsset.dependencies.push(capture.image.state);f.saveAsset(sourceAsset);
 const source={assetId:sourceAsset.id,version:sourceAsset.version,blob:sourceAsset.blob,pixels:sourceAsset.raster.pixels,width:5,height:3,scope:capture.scope,documentRevision:capture.documentRevision,capture:sourceAsset.raster.manifest};
 const samples=Buffer.alloc(5*3*2);for(const [x,y,value] of coverageValues)samples.writeUInt16LE(value,(y*5+x)*2);
 const hard=f.put(samples,'application/x-ideogram-r16le'),effective=f.put(samples,'application/x-ideogram-r16le');
 const maskAsset=f.raster('mask_1',5,3,'mask',{kind:'authored-mask-v2',hard,effective});f.saveAsset(maskAsset);
 const mask={assetId:maskAsset.id,version:maskAsset.version,blob:maskAsset.blob,pixels:maskAsset.raster.pixels,width:5,height:3,sourceHash:source.pixels.hash,polarity:'white-edit',fullAcknowledged:false,empty:false,full:false,plan:maskAsset.raster.manifest,binding:bindRequestMask(source)};
 const full=confirmRequestMask(source,mask,hard,effective,'approval_1');mask.requestPlan=createIdentityRequestPlan({...full,domain:{x:1,y:1,width:3,height:2}});
 f.job.review.request={kind:'inpaint',settings:f.job.review.request.settings,size:{kind:'auto'},source,mask,strength:1};f.saveJob();
 return {sourceAsset,maskAsset,source,mask,capture,plan:mask.requestPlan,samples};
}

// Model an already stored pixel product, independently of any adoption preview.
// Use the actual codec-qualified engine identity and the public typed manifest
// validators so a simplified worker substitute cannot accidentally qualify it.
function retainedPreservation(f,r,{id='retained_q_1',plan=r.plan,outputMapping=null,pipeline=PIPELINE,rooted=true}={}) {
 const {width,height}=plan.document,pixels=f.put(Buffer.alloc(width*height*4,201),'application/x-ideogram-rgba8'),tiles=[{x:0,y:0,width,height,hash:pixels.hash}];
 const dependencies=[r.sourceAsset.raster.manifest,f.prepared.raster.manifest,r.maskAsset.raster.manifest];
 for(const ref of [plan.sourcePixels,plan.authoredMask,plan.effectiveMask,...(outputMapping?[outputMapping.effectiveMask]:[])])if(!dependencies.some(value=>canonical(value)===canonical(ref)))dependencies.push(ref);
 const manifest={schemaVersion:1,pipeline,width,height,format:'straight-srgb-rgba8',layout:'row-major-tile-views-v1',tileSize:512,pixels,tiles,dependencies,plan:{kind:'request-preservation-v1',source:r.sourceAsset.raster.manifest,candidate:f.prepared.raster.manifest,mask:r.maskAsset.raster.manifest,requestPlan:plan,outputMapping}};
 validateRasterManifest(manifest);const manifestRef=f.put(manifest),pixelIdentity='sha256:'+createHash('sha256').update(canonical({pipeline,width,height,tiles})).digest('hex');
 const asset={id,version:'1',purpose:'image',blob:f.put('retained PNG '+id,'image/png'),dependencies:[manifestRef,pixels],safety:'safe',availability:'available',qualification:'canonical-raster',measuredMediaType:'image/png',raster:{schemaVersion:1,pipeline,width,height,manifest:manifestRef,pixels,pixelIdentity,role:'composite',sourceAssetIds:[r.sourceAsset.id,f.prepared.id,r.maskAsset.id],conversion:null}};
 validateAsset(asset);f.saveAsset(asset);if(rooted)f.db.prepare('INSERT INTO roots VALUES (?,?)').run('retained-preservation:'+id,manifestRef.hash);return {asset,manifest};
}
const reason=(code,detail)=>error=>error.code===code&&error.reason===detail;
const prepare=(f,mode='full-candidate',options={expectedVersion:f.candidate.version})=>f.candidates.prepareAdoption(f.candidate.id,mode,'adopted_1','adoption_fixture',()=>{},options);
const review=(f,mode='safe-region',options={expectedVersion:f.candidate.version})=>f.candidates.reviewAdoption(f.candidate.id,mode,'review_1','adoption_review_fixture',()=>{},options);
const acceptReviewed=(f,frozen)=>f.candidates.prepareReviewedAdoption(frozen,'accepted_1','adoption_accept_fixture',()=>{});

test('decoded metadata mismatch retains both candidate assets and releases preparation resources',async t=>{
 const f=fixture(t,{metadataWidth:4});f.saveCandidate({state:'downloaded',preparedAssetId:null});const original=structuredClone(f.original),beforeDocument=f.db.prepare('SELECT json FROM documents').get().json;
 await f.candidates.transfer(f.fence,f.candidate.id,{media(){assert.fail('retained original must not be fetched again');}},{});
 const candidate=f.readCandidate();assert.equal(candidate.state,'prepared');assert.equal(candidate.encodedAssetId,original.id);assert.equal(candidate.preparedAssetId,f.prepared.id);assert.match(candidate.warning,/provider metadata/);assert.equal(candidate.version,'5');
 assert.deepEqual(f.assets.asset(original.id),original);assert.deepEqual(f.assets.asset(candidate.preparedAssetId),f.prepared);assert.equal(f.db.prepare('SELECT json FROM documents').get().json,beforeDocument);
 assert.equal(f.calls.length,1);assert(f.registered.some(r=>r.owner==='candidate-prepared:'+f.prepared.id));assert.equal(f.activeProofs.size,0);assert.equal(f.slots.size,0);
});

test('decoded request grid mismatch remains retained for explicit output mapping review',async t=>{
 const f=fixture(t,{requestWidth:4});f.saveCandidate({state:'downloaded',preparedAssetId:null});
 await f.candidates.transfer(f.fence,f.candidate.id,{media(){assert.fail('no repeated output transfer');}},{});
 const candidate=f.readCandidate();assert.equal(candidate.state,'prepared');assert.equal(candidate.preparedAssetId,f.prepared.id);assert.equal(candidate.encodedAssetId,f.original.id);assert.match(candidate.warning,/output mapping review/);assert.deepEqual(f.verify(f.original.blob),Buffer.from('encoded provider original'));
});

test('external cancellation during asynchronous decoding retains the original and releases preparation resources',async t=>{
 const f=fixture(t),controller=new AbortController();f.saveCandidate({state:'downloaded',preparedAssetId:null});
 let entered,continueDecode;const decoding=new Promise(resolve=>entered=resolve),resume=new Promise(resolve=>continueDecode=resolve),worker=f.rasters.prepareDocument;
 f.rasters.prepareDocument=async(...args)=>{const result=await worker(...args);entered();await resume;try{args[3]();return result;}catch(error){f.release(result);throw error;}};
 const pending=f.candidates.transfer(f.fence,f.candidate.id,{media(){assert.fail('retained original must not be downloaded again');}},{},controller.signal);
 await decoding;assert(f.activeProofs.size>0);controller.abort();continueDecode();await pending;
 const candidate=f.readCandidate();assert.equal(candidate.state,'preparation-failed');assert.equal(candidate.encodedAssetId,f.original.id);assert.equal(candidate.preparedAssetId,null);assert.equal(f.activeProofs.size,0);assert.equal(f.slots.size,0);assert.equal(f.registered.length,0);assert.deepEqual(f.assets.asset(f.original.id),f.original);
});

test('full candidate adoption protects exact prepared bytes without rewriting the candidate or document',async t=>{
 const f=fixture(t),beforeCandidate=f.readCandidate(),beforeDocument=f.db.prepare('SELECT json FROM documents').get().json;
 const result=await prepare(f);assert.deepEqual(result.asset,f.prepared);assert.equal(result.plan,null);assert.equal(result.sourceCapture,null);assert.equal(result.outputMapping,null);assert.equal(result.coverage,null);assert.equal(f.calls.length,0);
 assert.deepEqual(new Set(result.proofs.map(p=>p.ref.hash)),new Set([f.prepared.blob,...f.prepared.dependencies].map(r=>r.hash)));
 assert.deepEqual(f.readCandidate(),beforeCandidate);assert.equal(f.db.prepare('SELECT json FROM documents').get().json,beforeDocument);assert.deepEqual(f.assets.asset(f.original.id),f.original);
 // The identity is data retained by an adoption preview, so revalidation must
 // also work through a fresh Candidates instance rather than only its closure.
 const identity=JSON.parse(JSON.stringify(result.identity));f.reopen().checkAdoption(identity);result.check();f.release(result);assert.equal(f.activeProofs.size,0);
});

test('safe-region adoption sends the captured source, exact coverage and approved crop to the raster worker',async t=>{
 const f=fixture(t),r=capturedRequest(f),before=f.readCandidate(),result=await prepare(f,'safe-region');
 assert.deepEqual(result.plan,r.plan);assert.deepEqual(result.sourceCapture,r.capture);assert.equal(result.outputMapping,null);assert.deepEqual(result.coverage,{originalEffectivePixels:4,effectivePixels:4,lostPixels:0});assert.equal(result.asset.id,'adopted_1');assert.equal(result.asset.raster.width,5);assert.equal(result.asset.raster.height,3);
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{type:'PreserveRequestCandidate',sourceAssetId:r.source.assetId,candidateAssetId:f.prepared.id,maskAssetId:r.mask.assetId,plan:r.plan});assert.equal(f.calls[0].documentId,f.document.id);
 assert(result.proofs.some(p=>p.ref.hash===r.source.capture.hash));assert(result.proofs.some(p=>p.ref.hash===r.capture.image.state.hash));assert.deepEqual(f.readCandidate(),before);assert.equal(f.registered.length,0);f.release(result);assert.equal(f.activeProofs.size,0);
});

test('review freezes normalized candidate inputs without producing preserved pixels or altering retained objects',async t=>{
 const f=fixture(t),r=capturedRequest(f),beforeCandidate=f.readCandidate(),beforeAssets=f.db.prepare('SELECT id,json FROM assets ORDER BY id').all(),beforeObjects=new Map([...f.content].map(([hash,bytes])=>[hash,Buffer.from(bytes)]));
 const result=await review(f);
 assert.deepEqual(result.asset,f.prepared);assert.equal(result.preparation,'deferred');assert.deepEqual([result.asset.raster.width,result.asset.raster.height],[3,2]);assert.equal(f.calls.length,0);assert.equal(f.finished.length,0);assert.equal(f.content.size,beforeObjects.size);
 assert.deepEqual(result.frozen,{kind:'candidate-adoption-inputs-1',mode:'safe-region',identity:result.identity,plan:r.plan,sourceCapture:r.capture,outputMapping:null,coverage:{originalEffectivePixels:4,effectivePixels:4,lostPixels:0}});
 for(const input of [f.prepared,r.sourceAsset,r.maskAsset])for(const ref of [input.blob,...input.dependencies])assert(result.proofs.some(proof=>proof.ref.hash===ref.hash),'review protects '+ref.hash);
 for(const [hash,bytes] of beforeObjects)assert.deepEqual(f.content.get(hash),bytes);assert.deepEqual(f.db.prepare('SELECT id,json FROM assets ORDER BY id').all(),beforeAssets);assert.deepEqual(f.readCandidate(),beforeCandidate);assert.equal(f.registered.length,0);
 const frozen=JSON.parse(JSON.stringify(result.frozen));f.release(result);assert.equal(f.activeProofs.size,0);
 const accepted=await f.reopen().prepareReviewedAdoption(frozen,'accepted_1','adoption_accept_fixture',()=>{});
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{type:'PreserveRequestCandidate',sourceAssetId:r.source.assetId,candidateAssetId:f.prepared.id,maskAssetId:r.mask.assetId,plan:r.plan});assert.equal(accepted.asset.id,'accepted_1');assert.deepEqual([accepted.asset.raster.width,accepted.asset.raster.height],[5,3]);assert.deepEqual(accepted.frozen,frozen);assert.deepEqual(accepted.identity,result.identity);
 for(const [hash,bytes] of beforeObjects)assert.deepEqual(f.content.get(hash),bytes);assert.deepEqual(f.readCandidate(),beforeCandidate);f.release(accepted);assert.equal(f.activeProofs.size,0);
});

test('accepted clipped review reuses its exact coverage object and approval without a second clipping stage',async t=>{
 const f=fixture(t,{width:1}),r=capturedRequest(f),beforeRequest=canonical(f.job.review.request),result=await review(f,'safe-region',{actualOutput:{width:1,height:2,clipMask:true}}),frozen=JSON.parse(JSON.stringify(result.frozen));
 assert.deepEqual(result.asset,f.prepared);assert.equal(f.calls.length,0);assert.equal(f.finished.length,1);assert.equal(frozen.outputMapping.resolution,'clipped-and-approved');assert.deepEqual(frozen.coverage,{originalEffectivePixels:4,effectivePixels:2,lostPixels:2});
 const reviewedBytes=Buffer.from(f.verify(frozen.outputMapping.effectiveMask)),finished=structuredClone(f.finished);f.release(result);
 const accepted=await acceptReviewed(f,frozen);
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body.outputMapping,frozen.outputMapping);assert.deepEqual(accepted.outputMapping,frozen.outputMapping);assert.equal(accepted.outputMapping.approvalId,result.outputMapping.approvalId);assert.deepEqual(accepted.frozen,frozen);assert.deepEqual(f.finished,finished);assert.equal(f.streams.size,0);
 assert.deepEqual(f.verify(accepted.outputMapping.effectiveMask),reviewedBytes);assert.deepEqual(f.verify(r.plan.effectiveMask),r.samples);assert.equal(canonical(f.job.review.request),beforeRequest);assert(accepted.proofs.some(proof=>proof.ref.hash===frozen.outputMapping.effectiveMask.hash));f.release(accepted);assert.equal(f.activeProofs.size,0);
});

test('full candidate review and acceptance retain native pixels without a preservation worker',async t=>{
 const f=fixture(t),result=await review(f,'full-candidate'),frozen=JSON.parse(JSON.stringify(result.frozen));f.release(result);
 const accepted=await acceptReviewed(f,frozen);assert.deepEqual(result.asset,f.prepared);assert.equal(result.preparation,'prepared-reuse');assert.deepEqual(accepted.asset,f.prepared);assert.equal(accepted.preparation,'prepared-reuse');assert.deepEqual(accepted.frozen,frozen);assert.equal(f.calls.length,0);assert.equal(f.finished.length,0);f.release(accepted);assert.equal(f.activeProofs.size,0);
});

test('an exact stored preservation is reported ready and reused without a prior preview or another worker',async t=>{
 const f=fixture(t),r=capturedRequest(f),q=retainedPreservation(f,r),beforeAssets=f.db.prepare('SELECT id,json FROM assets ORDER BY id').all(),beforeObjects=new Map([...f.content].map(([hash,bytes])=>[hash,Buffer.from(bytes)]));
 assert.equal(q.asset.raster.pipeline,PIPELINE);const result=await review(f),frozen=JSON.parse(JSON.stringify(result.frozen));
 assert.equal(result.preparation,'prepared-reuse');assert.deepEqual(result.asset,f.prepared);assert.equal(f.calls.length,0);for(const ref of [q.asset.blob,...q.asset.dependencies,...q.manifest.dependencies])assert(result.proofs.some(proof=>canonical(proof.ref)===canonical(ref)));
 f.release(result);const accepted=await f.reopen().prepareReviewedAdoption(frozen,'accepted_1','adoption_accept_fixture',()=>{});
 assert.equal(accepted.preparation,'prepared-reuse');assert.deepEqual(accepted.asset,q.asset);assert.deepEqual(accepted.frozen,frozen);assert.equal(f.calls.length,0);assert.equal(f.finished.length,0);assert.equal(f.content.size,beforeObjects.size);assert.deepEqual(f.db.prepare('SELECT id,json FROM assets ORDER BY id').all(),beforeAssets);
 for(const [hash,bytes] of beforeObjects)assert.deepEqual(f.content.get(hash),bytes);f.release(accepted);assert.equal(f.activeProofs.size,0);
});

test('different retained plan or codec identity leaves preservation deferred and requires one worker',async t=>{
 for(const which of ['request plan','codec pipeline'])await t.test(which,async t=>{
  const f=fixture(t),r=capturedRequest(f),options=which==='request plan'?{plan:{...r.plan,approvalId:'earlier_approval'}}:{pipeline:PIPELINE.split('/')[0]+'/sha256:'+'0'.repeat(64)},q=retainedPreservation(f,r,options),result=await review(f);
  assert.equal(result.preparation,'deferred');assert.equal(f.calls.length,0);const frozen=JSON.parse(JSON.stringify(result.frozen));f.release(result);
  const accepted=await acceptReviewed(f,frozen);assert.equal(accepted.preparation,'deferred');assert.equal(accepted.asset.id,'accepted_1');assert.notEqual(accepted.asset.id,q.asset.id);assert.equal(f.calls.length,1);assert.deepEqual(f.assets.asset(q.asset.id),q.asset);f.release(accepted);assert.equal(f.activeProofs.size,0);
 });
});

test('missing retained preservation bytes fail reuse without manufacturing replacement pixels',async t=>{
 for(const missing of ['PNG','pixels','manifest'])await t.test(missing,async t=>{
  const f=fixture(t),r=capturedRequest(f),q=retainedPreservation(f,r),result=await review(f),frozen=JSON.parse(JSON.stringify(result.frozen));f.release(result);
  const ref=missing==='PNG'?q.asset.blob:missing==='pixels'?q.asset.raster.pixels:q.asset.raster.manifest;f.content.delete(ref.hash);
  await assert.rejects(acceptReviewed(f,frozen),error=>error.code==='MISSING_OBJECT');assert.equal(f.calls.length,0);assert.equal(f.finished.length,0);assert.equal(f.activeProofs.size,0);
 });
});

test('an unrooted stale preservation row with collected manifest is ignored and recomputed',async t=>{
 const f=fixture(t),r=capturedRequest(f),stale=retainedPreservation(f,r,{rooted:false});f.content.delete(stale.asset.raster.manifest.hash);
 const result=await review(f);assert.equal(result.preparation,'deferred');assert.equal(f.calls.length,0);const frozen=JSON.parse(JSON.stringify(result.frozen));f.release(result);
 const accepted=await acceptReviewed(f,frozen);assert.equal(accepted.preparation,'deferred');assert.equal(accepted.asset.id,'accepted_1');assert.equal(f.calls.length,1);assert.deepEqual(f.assets.asset(stale.asset.id),stale.asset);f.release(accepted);assert.equal(f.activeProofs.size,0);
});

test('more than sixty-five unrooted stale preservation rows do not consume the rooted lookup bound',async t=>{
 const f=fixture(t),r=capturedRequest(f);
 for(let index=0;index<70;index++){const stale=retainedPreservation(f,r,{id:'stale_q_'+String(index).padStart(2,'0'),plan:{...r.plan,approvalId:'stale_approval_'+index},rooted:false});f.content.delete(stale.asset.raster.manifest.hash);}
 const q=retainedPreservation(f,r),result=await review(f);assert.equal(result.preparation,'prepared-reuse');const frozen=JSON.parse(JSON.stringify(result.frozen));f.release(result);
 const accepted=await acceptReviewed(f,frozen);assert.equal(accepted.preparation,'prepared-reuse');assert.deepEqual(accepted.asset,q.asset);assert.equal(f.calls.length,0);f.release(accepted);assert.equal(f.activeProofs.size,0);
});

test('reuse detects an asset record changed during proof acquisition and releases every proof',async t=>{
 const f=fixture(t),r=capturedRequest(f),q=retainedPreservation(f,r),prove=f.objects.prove;let changed=false;
 f.objects.prove=async(ref,check)=>{const token=await prove(ref,check);if(ref.hash===q.asset.blob.hash&&!changed){changed=true;f.saveAsset({...q.asset,version:'2'});}return token;};
 await assert.rejects(review(f),reason('STALE_REVISION','CANDIDATE_REVIEW_CHANGED'));assert(changed);assert.equal(f.calls.length,0);assert.equal(f.activeProofs.size,0);
});

test('the final reused-pixel guard rejects a later change to the retained asset record',async t=>{
 const f=fixture(t),r=capturedRequest(f),q=retainedPreservation(f,r),result=await review(f),frozen=JSON.parse(JSON.stringify(result.frozen));f.release(result);
 const accepted=await acceptReviewed(f,frozen);assert.deepEqual(accepted.asset,q.asset);f.saveAsset({...q.asset,availability:'missing'});
 assert.throws(()=>accepted.check(),reason('STALE_REVISION','CANDIDATE_REVIEW_CHANGED'));f.release(accepted);assert.equal(f.calls.length,0);assert.equal(f.activeProofs.size,0);
});

test('sixty-five possible retained preservations refuse the bounded lookup before running a worker',async t=>{
 const f=fixture(t),r=capturedRequest(f),result=await review(f),frozen=JSON.parse(JSON.stringify(result.frozen));f.release(result);
 for(let index=0;index<65;index++)retainedPreservation(f,r,{id:'retained_q_'+String(index).padStart(2,'0')});
 await assert.rejects(review(f),error=>error.code==='CAPACITY');assert.equal(f.activeProofs.size,0);
 await assert.rejects(acceptReviewed(f,frozen),error=>error.code==='CAPACITY');assert.equal(f.calls.length,0);assert.equal(f.finished.length,0);assert.equal(f.activeProofs.size,0);
});

test('schema seventeen indexes the actual retained-preservation lookup and restores both indexes idempotently',async t=>{
 const f=fixture(t),r=capturedRequest(f);retainedPreservation(f,r);
 const root=await mkdtemp(join(await realpath(tmpdir()),'candidate-reuse-index-'));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));
 f.db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,receipt TEXT NOT NULL); PRAGMA user_version=16');
 const assetsBefore=f.db.prepare('SELECT id,json FROM assets ORDER BY id').all(),rootsBefore=f.db.prepare('SELECT owner,hash FROM roots ORDER BY owner,hash').all();
 p2SemanticSchema(f.db,root,()=>{},undefined,true);
 assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,17);for(const name of ['assets_preservation_inputs','roots_hash'])assert(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?").get(name));
 const receipt=f.db.prepare('SELECT receipt FROM schema_migrations WHERE version=17').get().receipt,schema=f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
 assert.equal(JSON.parse(receipt).capability,'p2-request-adoption-adapters-v1');
 // Capture the product query itself. A copied predicate in this test could
 // appear indexed while the real warm-reuse lookup silently regressed.
 const originalPrepare=f.db.prepare.bind(f.db),queries=[];
 f.db.prepare=sql=>{if(sql.startsWith('SELECT a.id FROM assets a '))queries.push(sql);return originalPrepare(sql);};
 let result;try{result=await review(f);}finally{f.db.prepare=originalPrepare;}
 assert.equal(result.preparation,'prepared-reuse');f.release(result);assert.equal(queries.length,1);
 const details=f.db.prepare('EXPLAIN QUERY PLAN '+queries[0]).all(PIPELINE,canonical([r.sourceAsset.id,f.prepared.id,r.maskAsset.id])).map(row=>String(row.detail));
 assert(details.some(detail=>/\bSEARCH a USING (?:COVERING )?INDEX assets_preservation_inputs\b/.test(detail)),details.join('\n'));
 assert(details.some(detail=>/\bSEARCH r(?: EXISTS)? USING (?:COVERING )?INDEX roots_hash\b/.test(detail)),details.join('\n'));
 assert(!details.some(detail=>/\bSCAN (?:a|r)\b/.test(detail)),details.join('\n'));assert(!details.some(detail=>/USE TEMP B-TREE/i.test(detail)),details.join('\n'));
 f.db.exec('DROP INDEX assets_preservation_inputs; DROP INDEX roots_hash');p2SemanticSchema(f.db,root,()=>{},undefined,true);p2SemanticSchema(f.db,root,()=>{},undefined,true);
 assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,17);assert.equal(f.db.prepare('SELECT receipt FROM schema_migrations WHERE version=17').get().receipt,receipt);assert.equal(f.db.prepare('SELECT count(*) n FROM schema_migrations').get().n,1);
 assert.deepEqual(f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),schema);assert.deepEqual(f.db.prepare('SELECT id,json FROM assets ORDER BY id').all(),assetsBefore);assert.deepEqual(f.db.prepare('SELECT owner,hash FROM roots ORDER BY owner,hash').all(),rootsBefore);assert.equal(f.activeProofs.size,0);assert.equal(f.calls.length,0);
});

test('candidate, mask and queue controls changed after review are rejected before preservation starts',async t=>{
 for(const which of ['candidate','mask','controls'])await t.test(which,async t=>{
  const f=fixture(t),r=capturedRequest(f),result=await review(f),frozen=JSON.parse(JSON.stringify(result.frozen));f.release(result);
  if(which==='candidate')f.saveCandidate({version:'5'});else if(which==='mask')f.saveAsset({...r.maskAsset,version:'2'});else{f.fence.jobVersion='2';f.job.version='2';}
  await assert.rejects(acceptReviewed(f,frozen),reason('STALE_REVISION',which==='mask'?'REQUEST_MASK_CHANGED':'CANDIDATE_CHANGED'));assert.equal(f.calls.length,0);assert.equal(f.finished.length,0);assert.equal(f.activeProofs.size,0);
 });
});

test('acceptance refuses altered review coverage and a substituted clipped coverage object',async t=>{
 for(const which of ['coverage measurement','clipped samples'])await t.test(which,async t=>{
  const f=fixture(t,{width:1});capturedRequest(f);const result=await review(f,'safe-region',{actualOutput:{width:1,height:2,clipMask:true}}),frozen=JSON.parse(JSON.stringify(result.frozen));f.release(result);
  if(which==='coverage measurement')frozen.coverage.effectivePixels=1;
  else{const forged=Buffer.from(f.verify(frozen.outputMapping.effectiveMask));forged.writeUInt16LE(258,(1*5+2)*2);frozen.outputMapping.effectiveMask=f.put(forged,'application/x-ideogram-r16le');}
  await assert.rejects(acceptReviewed(f,frozen),reason('STALE_REVISION','CANDIDATE_REVIEW_CHANGED'));assert.equal(f.calls.length,0);assert.equal(f.finished.length,1);assert.equal(f.streams.size,0);assert.equal(f.activeProofs.size,0);
 });
});

test('failed accepted preservation releases newly acquired proofs and leaves reviewed inputs available',async t=>{
 const f=fixture(t),r=capturedRequest(f),result=await review(f),frozen=JSON.parse(JSON.stringify(result.frozen));f.release(result);
 f.rasters.prepareDocument=async(body)=>{f.calls.push({body});throw new StoreError('STORAGE_FULL');};
 await assert.rejects(acceptReviewed(f,frozen),error=>error.code==='STORAGE_FULL');assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.type,'PreserveRequestCandidate');assert.equal(f.activeProofs.size,0);assert.equal(f.streams.size,0);assert.equal(f.registered.length,0);assert.equal(f.readCandidate().state,'prepared');
 for(const input of [f.prepared,r.sourceAsset,r.maskAsset])for(const ref of [input.blob,...input.dependencies])assert(f.verify(ref));
});

test('a different decoded grid requires explicit mapping review while full candidate remains available',async t=>{
 const f=fixture(t,{width:4});capturedRequest(f);
 await assert.rejects(prepare(f,'safe-region'),reason('INCOMPATIBLE','OUTPUT_MAPPING_REVIEW_REQUIRED'));assert.equal(f.calls.length,0);assert.equal(f.activeProofs.size,0);
 const full=await prepare(f);assert.equal(full.asset.id,f.prepared.id);assert.equal(full.asset.raster.width,4);f.release(full);
});

test('output mapping approval must name the actual decoded dimensions and clipping choice',async t=>{
 for(const actualOutput of [{width:2,height:2,clipMask:true},{width:1,height:1,clipMask:true},{width:1,height:2}])await t.test(JSON.stringify(actualOutput),async t=>{
  const f=fixture(t,{width:1});capturedRequest(f);
  await assert.rejects(prepare(f,'safe-region',{actualOutput}),reason('INCOMPATIBLE','OUTPUT_MAPPING_REVIEW_REQUIRED'));assert.equal(f.calls.length,0);assert.equal(f.finished.length,0);assert.equal(f.activeProofs.size,0);
 });
});

test('actual output mapping cannot discard positive R16 coverage without explicit clipping approval',async t=>{
 const f=fixture(t,{width:1}),r=capturedRequest(f),before=Buffer.from(f.verify(r.plan.effectiveMask));
 await assert.rejects(prepare(f,'safe-region',{actualOutput:{width:1,height:2,clipMask:false}}),reason('INCOMPATIBLE','MASK_DOMAIN_REVIEW_REQUIRED'));
 assert.equal(f.calls.length,0);assert.equal(f.finished.length,0);assert.equal(f.streams.size,0);assert.equal(f.activeProofs.size,0);assert.deepEqual(f.verify(r.plan.effectiveMask),before);
});

test('explicit output clipping retains exact R16 samples only in the independently known safe interior',async t=>{
 const f=fixture(t,{width:1}),r=capturedRequest(f),beforePlan=structuredClone(r.plan),beforeRequest=canonical(f.job.review.request),beforeMask=Buffer.from(r.samples),beforeCandidate=f.readCandidate();
 const result=await prepare(f,'safe-region',{actualOutput:{width:1,height:2,clipMask:true}}),mapping=result.outputMapping;
 // A 3-cell crop [1,4) reconstructed from one output cell loses its two edge
 // cells to the triangle footprint. Only x=2 survives at y=1 and y=2. These
 // literal little-endian bytes do not use the product clipping calculation.
 const expected=Buffer.from([
  0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,1,1,0,0,0,0,
  0,0,0,0,0,128,0,0,0,0,
 ]);
 assert(mapping);assert.equal(mapping.kind,'request-output-mapping-1');assert.equal(mapping.resolution,'clipped-and-approved');assert.deepEqual(mapping.actualOutput,{width:1,height:2});assert.deepEqual(mapping.outputToDocument,[3,0,0,1,1,1]);assert.equal(mapping.reconstructionHalo,1);assert.notEqual(mapping.approvalId,r.plan.approvalId);
 assert.deepEqual(f.verify(mapping.effectiveMask),expected);assert.deepEqual(result.coverage,{originalEffectivePixels:4,effectivePixels:2,lostPixels:2});assert.notEqual(mapping.effectiveMask.hash,r.plan.effectiveMask.hash);assert.deepEqual(f.finished,[mapping.effectiveMask]);assert.equal(f.streams.size,0);
 assert.deepEqual(mapping.requestPlan,beforePlan);assert.deepEqual(result.plan,beforePlan);assert.deepEqual(result.plan.expectedOutput,{width:3,height:2});assert.equal(canonical(f.job.review.request),beforeRequest);assert.deepEqual(f.verify(r.plan.effectiveMask),beforeMask);assert.deepEqual(f.readCandidate(),beforeCandidate);
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body.outputMapping,mapping);assert.deepEqual(f.calls[0].body.plan,beforePlan);assert(result.proofs.some(p=>p.ref.hash===mapping.effectiveMask.hash));assert(result.proofs.some(p=>p.ref.hash===r.plan.effectiveMask.hash));f.release(result);assert.equal(f.activeProofs.size,0);
});

test('contained actual output mapping reuses the exact original coverage without a clipping object',async t=>{
 const f=fixture(t,{width:1}),r=capturedRequest(f,{coverageValues:[[2,1,257],[2,2,32768]]});
 const result=await prepare(f,'safe-region',{actualOutput:{width:1,height:2,clipMask:false}});
 assert.equal(result.outputMapping.resolution,'already-contained');assert.deepEqual(result.outputMapping.effectiveMask,r.plan.effectiveMask);assert.deepEqual(result.outputMapping.requestPlan,r.plan);assert.deepEqual(result.coverage,{originalEffectivePixels:2,effectivePixels:2,lostPixels:0});assert.equal(f.finished.length,0);assert.equal(f.streams.size,0);assert.equal(f.calls.length,1);f.release(result);assert.equal(f.activeProofs.size,0);
});

test('failed successor coverage storage aborts its stream and cannot start preservation',async t=>{
 const f=fixture(t,{width:1}),r=capturedRequest(f),original=Buffer.from(r.samples),write=f.objects.chunk;
 f.objects.chunk=(id,bytes)=>{write(id,bytes);throw new StoreError('STORAGE_FULL');};
 await assert.rejects(prepare(f,'safe-region',{actualOutput:{width:1,height:2,clipMask:true}}),error=>error.code==='STORAGE_FULL');
 assert.equal(f.streams.size,0);assert.equal(f.finished.length,0);assert.equal(f.activeProofs.size,0);assert.equal(f.calls.length,0);assert.deepEqual(f.verify(r.plan.effectiveMask),original);assert.equal(f.readCandidate().state,'prepared');
});

test('full candidate adoption does not accept a safe-region output mapping approval',async t=>{
 const f=fixture(t,{width:1});capturedRequest(f);
 await assert.rejects(prepare(f,'full-candidate',{actualOutput:{width:1,height:2,clipMask:true}}),reason('INCOMPATIBLE','OUTPUT_MAPPING_REQUIRES_SAFE_REGION'));assert.equal(f.calls.length,0);assert.equal(f.activeProofs.size,0);assert.equal(f.finished.length,0);
});

test('safe-region adoption refuses a generation candidate without an immutable source capture',async t=>{
 const f=fixture(t);await assert.rejects(prepare(f,'safe-region'),reason('INCOMPATIBLE','REQUEST_SOURCE_CAPTURE_REQUIRED'));assert.equal(f.calls.length,0);assert.equal(f.activeProofs.size,0);
});

test('a legacy masked request without an approved preservation plan still allows isolated full candidate adoption',async t=>{
 const f=fixture(t),r=capturedRequest(f);delete f.job.review.request.mask.requestPlan;f.saveJob();const beforeRequest=canonical(f.job.review.request),beforeCandidate=f.readCandidate();
 const result=await prepare(f,'full-candidate');assert.deepEqual(result.asset,f.prepared);assert.equal(result.asset.raster.role,'native');assert.equal(result.plan,null);assert.equal(result.outputMapping,null);assert.deepEqual(result.sourceCapture,r.capture);assert.equal(f.calls.length,0);f.release(result);
 await assert.rejects(prepare(f,'safe-region'),reason('INCOMPATIBLE','REQUEST_SOURCE_CAPTURE_REQUIRED'));assert.equal(f.calls.length,0);assert.equal(f.activeProofs.size,0);assert.equal(canonical(f.job.review.request),beforeRequest);assert.deepEqual(f.readCandidate(),beforeCandidate);
});

test('stale candidate version is rejected before acquiring proofs or running a worker',async t=>{
 const f=fixture(t);await assert.rejects(prepare(f,'full-candidate',{expectedVersion:'3'}),reason('STALE_REVISION','CANDIDATE_CHANGED'));assert.equal(f.calls.length,0);assert.equal(f.activeProofs.size,0);
});

for(const [name,patch] of [['hidden',{hidden:true}],['unknown safety',{safety:'unknown'}],['withheld safety',{safety:'withheld'}],['failed preparation',{state:'preparation-failed'}],['missing prepared identity',{preparedAssetId:null}]])test(name+' cannot be adopted',async t=>{
 const f=fixture(t);f.saveCandidate(patch);await assert.rejects(prepare(f),reason('INCOMPATIBLE','CANDIDATE_NOT_PREPARED'));assert.equal(f.calls.length,0);assert.equal(f.activeProofs.size,0);
});

for(const [name,patch] of [['quarantined prepared raster',{safety:'quarantined'}],['missing prepared raster bytes',{availability:'missing'}],['unapproved prepared raster',{qualification:'raster-preview'}]])test(name+' cannot be adopted',async t=>{
 const f=fixture(t);f.saveAsset({...f.prepared,...patch});await assert.rejects(prepare(f),reason('INCOMPATIBLE','CANDIDATE_NOT_PREPARED'));assert.equal(f.calls.length,0);assert.equal(f.activeProofs.size,0);
});

test('source capture and mask identities are rechecked against the frozen request',async t=>{
 for(const which of ['source','mask'])await t.test(which,async t=>{
  const f=fixture(t),r=capturedRequest(f),asset=which==='source'?r.sourceAsset:r.maskAsset;f.saveAsset({...asset,version:'2'});
  await assert.rejects(prepare(f,'safe-region'),reason('STALE_REVISION',which==='source'?'REQUEST_SOURCE_CHANGED':'REQUEST_MASK_CHANGED'));assert.equal(f.calls.length,0);assert.equal(f.activeProofs.size,0);
 });
});

test('same-version source manifest substitution revokes an already prepared adoption',async t=>{
 const f=fixture(t),r=capturedRequest(f),result=await prepare(f,'full-candidate'),originalManifest=r.sourceAsset.raster.manifest;
 f.saveAsset({...r.sourceAsset,raster:{...r.sourceAsset.raster,manifest:f.put({kind:'substituted-source-manifest'})}});
 assert.equal(f.assets.asset(r.sourceAsset.id).version,r.sourceAsset.version);assert.deepEqual(f.job.review.request.source.capture,originalManifest);
 assert.throws(()=>result.check(),reason('STALE_REVISION','REQUEST_SOURCE_CHANGED'));assert.throws(()=>f.reopen().checkAdoption(JSON.parse(JSON.stringify(result.identity))),reason('STALE_REVISION','REQUEST_SOURCE_CHANGED'));f.release(result);assert.equal(f.activeProofs.size,0);
});

test('a candidate changed while safe-region pixels are prepared cannot escape the final guard',async t=>{
 const f=fixture(t);capturedRequest(f);const worker=f.rasters.prepareDocument;
 f.rasters.prepareDocument=async(...args)=>{const result=await worker(...args);f.saveCandidate({version:'5',hidden:true});return result;};
 await assert.rejects(prepare(f,'safe-region'),reason('STALE_REVISION','CANDIDATE_CHANGED'));assert.equal(f.calls.length,1);assert.equal(f.registered.length,0);assert.equal(f.activeProofs.size,0);
});

test('persisted adoption identity rejects a later request mutation and prepared asset substitution',async t=>{
 for(const which of ['request','prepared asset'])await t.test(which,async t=>{
  const f=fixture(t),result=await prepare(f),identity=JSON.parse(JSON.stringify(result.identity));f.release(result);
  if(which==='request'){f.job.review.request.size.width=4;f.saveJob();}else f.saveAsset({...f.prepared,blob:f.put('different png','image/png')});
  assert.throws(()=>f.reopen().checkAdoption(identity),reason('STALE_REVISION',which==='request'?'CANDIDATE_REQUEST_CHANGED':'CANDIDATE_CHANGED'));
 });
});

test('missing prepared content fails adoption without leaking any acquired proofs',async t=>{
 const f=fixture(t);f.content.delete(f.prepared.raster.manifest.hash);
 await assert.rejects(prepare(f),error=>error.code==='MISSING_OBJECT');assert.equal(f.activeProofs.size,0);assert.equal(f.calls.length,0);
});

test('document tombstone revokes a previously prepared adoption identity',async t=>{
 const f=fixture(t),result=await prepare(f);f.release(result);f.db.prepare('INSERT INTO candidate_document_tombstones VALUES (?,?)').run(f.document.id,'1');
 assert.throws(()=>result.check(),reason('STALE_REVISION','CANDIDATE_CHANGED'));assert.equal(f.db.prepare('SELECT count(*) n FROM candidates').get().n,1);
});

test('a removed candidate produces a terminal stale revision rejection for preparation and retained guards',async t=>{
 const f=fixture(t),result=await prepare(f);f.release(result);f.db.prepare('DELETE FROM candidates WHERE id=?').run(f.candidate.id);
 assert.throws(()=>result.check(),reason('STALE_REVISION','CANDIDATE_CHANGED'));await assert.rejects(prepare(f),reason('STALE_REVISION','CANDIDATE_CHANGED'));assert.equal(f.activeProofs.size,0);
});

test('a changed queue result fence produces a stale revision rejection instead of a parked preparation',async t=>{
 const f=fixture(t),result=await prepare(f);f.release(result);f.fence.jobVersion='2';f.job.version='2';
 assert.throws(()=>result.check(),reason('STALE_REVISION','CANDIDATE_CHANGED'));assert.equal(f.activeProofs.size,0);
});

test('initial unavailable queue lookups become terminal candidate revision rejections',async t=>{
 for(const [method,code] of [['resultFence','NOT_FOUND'],['assertResult','STALE_EPOCH']])await t.test(method,async t=>{
  const f=fixture(t);f.candidates.queue[method]=()=>{throw new StoreError(code);};
  await assert.rejects(prepare(f),reason('STALE_REVISION','CANDIDATE_CHANGED'));assert.equal(f.calls.length,0);assert.equal(f.activeProofs.size,0);
 });
});

test('due eligibility is applied before the twenty-result cap across queue pages',t=>{
 const f=fixture(t),entries=Array.from({length:21},(_,index)=>{
  const jobId=index>=19?'job_selected':'job_due_'+String(index).padStart(2,'0'),attemptId='attempt_due_'+String(index).padStart(2,'0');
  const fence={...f.fence,jobId,attemptId,requestId:'request_due_'+index};
  const job={...f.job,id:jobId,attempts:[{id:attemptId,requestId:fence.requestId,state:'acknowledged',recoveryRequired:false}]};
  const retained={jobId,attemptId,documentId:f.document.id,requestedCount:1,actualCount:null,provenance:null,observation:{phase:'queued',nextPollAt:10,failures:0,mode:'healthy',digest:null,resultDigest:null,warning:null}};
  f.db.prepare('INSERT INTO candidate_jobs VALUES (?,?)').run(attemptId,canonical(retained));return {fence,job};
 }),selected=entries[20],pages=[];
 f.candidates.queue.view=cursor=>{pages.push(cursor);assert(['','next_page'].includes(cursor));return cursor===''?{jobs:entries.slice(0,20).map(e=>e.job),nextCursor:'next_page'}:{jobs:[selected.job],nextCursor:null};};
 f.candidates.queue.resultFence=(jobId,attemptId)=>{const entry=entries.find(e=>e.fence.jobId===jobId&&e.fence.attemptId===attemptId);assert(entry);return entry.fence;};
 assert.deepEqual(f.candidates.due(10),entries.slice(0,20).map(e=>e.fence));assert.deepEqual(pages,['']);pages.length=0;
 const inspected=[],eligible=(jobId,attemptId)=>{inspected.push([jobId,attemptId]);return jobId===selected.fence.jobId&&attemptId===selected.fence.attemptId;};
 assert.deepEqual(f.candidates.due(10,eligible),[selected.fence]);assert.deepEqual(pages,['','next_page']);assert.equal(inspected.length,21);assert(inspected.some(([jobId,attemptId])=>jobId==='job_selected'&&attemptId!==selected.fence.attemptId));assert.equal(f.db.prepare('SELECT count(*) n FROM candidate_journal').get().n,0);
});

test('retry eligibility is applied before the twenty-result cap in retained candidate order',t=>{
 const f=fixture(t),entries=Array.from({length:21},(_,index)=>{
  const suffix=String(index).padStart(2,'0'),candidate={...f.candidate,id:'candidate_retry_'+suffix,jobId:index>=19?'job_selected':'job_retry_'+suffix,attemptId:'attempt_retry_'+suffix,state:'transfer-failed',preparedAssetId:null};
  f.db.prepare('INSERT INTO candidates VALUES (?,?,?,?)').run(candidate.id,candidate.documentId,candidate.jobId,canonical(candidate));f.db.prepare('INSERT INTO candidate_private VALUES (?,?)').run(candidate.id,canonical({retryRequested:true}));return candidate;
 }),selected=entries[20];
 assert.deepEqual(f.candidates.retries(),entries.slice(0,20));
 const inspected=[],eligible=(jobId,attemptId)=>{inspected.push([jobId,attemptId]);return jobId===selected.jobId&&attemptId===selected.attemptId;};
 assert.deepEqual(f.candidates.retries(eligible),[selected]);assert.equal(inspected.length,21);assert(inspected.some(([jobId,attemptId])=>jobId==='job_selected'&&attemptId!==selected.attemptId));assert.equal(f.db.prepare('SELECT count(*) n FROM candidate_journal').get().n,0);
});

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants,openSync,readSync,closeSync} from 'node:fs';
import {lstat,realpath,readFile,readdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {product,phase} from './backend-common.mjs';
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const encode=value=>Buffer.from(JSON.stringify(value));
export function* chunks(path){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{for(;;){const bytes=Buffer.alloc(32768),size=readSync(fd,bytes);if(!size)break;yield bytes.subarray(0,size);}}finally{closeSync(fd);}}
export async function validateInputDescriptor(store,input){
 assert(input&&typeof input.path==='string'&&/^qualification-composition-inputs\/[A-Za-z0-9_.-]+$/.test(input.path));
 assert(/^sha256:[a-f0-9]{64}$/.test(input.sha256)&&/^[1-9][0-9]*$/.test(String(input.byteLength)));
 const path=resolve(store.root,input.path),directory=join(store.root,'qualification-composition-inputs');
 assert.equal(dirname(path),directory);assert.equal(await realpath(directory),directory);
 const parent=await lstat(directory);assert(parent.isDirectory()&&!parent.isSymbolicLink()&&(parent.mode&0o777)===0o700);if(process.getuid)assert.equal(parent.uid,process.getuid());
 const stat=await lstat(path);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&(stat.mode&0o077)===0);if(process.getuid)assert.equal(stat.uid,process.getuid());
 assert.equal(String(stat.size),String(input.byteLength));assert(stat.size<=64*1024*1024);
 const digest=createHash('sha256');let bytes=0;for(const chunk of chunks(path)){digest.update(chunk);bytes+=chunk.length;}assert.equal('sha256:'+digest.digest('hex'),input.sha256);assert.equal(String(bytes),String(input.byteLength));return path;
}
async function seedAttempt(store,payload,context){
 const {resolvePrivacy}=await product(context,'server/provider/policy.js');
 const {jobId,attemptId}=payload;assert(typeof jobId==='string'&&typeof attemptId==='string');
 const profile={id:'campaign-local-only',version:1,evidenceDigest:'0'.repeat(64),endpoint:'ideogram/v4',mode:'fixture',enforcement:'observed',lifecycleSeconds:3600,minimumCompatibleSeconds:3600,acl:'private',supportedLifetimes:[3600],supportedACLs:['private'],mostPrivateACL:'private',deferredFetch:'bounded',requiredLifetimeSeconds:3600,renewalQualified:false};
 const policy=resolvePrivacy(profile,profile.endpoint,attemptId).applied;
 assert(store.queue.reserve(jobId));const dispatch=store.queue.dispatch(jobId,attemptId,{},policy);assert(dispatch);
 const requestId='sealed_'+attemptId,base='https://queue.fal.run/ideogram/v4/requests/'+requestId,urls={status:base+'/status',result:base,cancel:base+'/cancel'};
 const ackSink=store.queue.sink(attemptId,'response',policy);ackSink.append(encode({request_id:requestId,status_url:urls.status,response_url:urls.result,cancel_url:urls.cancel}));const ack=ackSink.finish(true);
 store.queue.outcome(jobId,attemptId,dispatch.epoch,{kind:'ack',requestId,urls,responseRecord:ack.recordId});
 // A deterministic protected status specimen releases the actual product hold.
 // This is fixture seeding outside the measured result span, never HTTP evidence.
 const statusSink=store.queue.sink(attemptId,'response',policy);statusSink.append(encode({request_id:requestId,status:'COMPLETED'}));const status=statusSink.finish(true);
 store.candidates.observe(store.queue.resultFence(jobId,attemptId),status,Date.now());
 assert.equal(store.queue.recovery(jobId,attemptId).attempt.hold,false);
 return {policy,fence:store.queue.resultFence(jobId,attemptId),seededStatus:status.recordId};
}
export async function ingest(store,payload,context){
 const partial=payload.action==='partial-ingest',id=payload.caseId;
 assert(partial?id==='WJ24':['RAW16M','RAW16M_PLUS1'].includes(id));
 const path=await validateInputDescriptor(store,payload.input),phases=[];
 const {policy,fence,seededStatus}=await seedAttempt(store,payload,context);
 try {
 const evidence=store.queue.evidence,records=partial?new Set(await readdir(evidence.directory)):null;
 const expectedBytes=id==='RAW16M'?16777216:16777217;let expectedHash=null;
 if(!partial){const {rawPromptChunks}=await import('./backend-composition.mjs'),digest=createHash('sha256');for(const bytes of rawPromptChunks(expectedBytes))digest.update(bytes);expectedHash='sha256:'+digest.digest('hex');}
 let source,view,prefix;
 try { await phase(phases,partial?'caption.partial-envelope-ingest-hash-durability':'result.prompt-ingest-durable',()=>{
  const response=store.queue.sink(payload.attemptId,'response',policy);
  try{for(const chunk of chunks(path))response.append(chunk);source=response.finish(!partial);}catch(error){response.finish(false);throw error;}
  view=store.candidates.receive(fence,source,policy,[]);
 }); } catch(error) { return {phases,error:{name:error.name,code:error.code??null,message:String(error.message)}}; }
 for(const span of phases){span.clock='product-writer-monotonic';span.writerEpoch=store.epoch;}
 assert.equal('sha256:'+source.sha256,payload.input.sha256);assert.equal(source.receivedBytes,String(payload.input.byteLength));
 if(partial){
  assert.equal(view.provenance.complete,false);assert.equal(view.provenance.returnedPrompt,null);assert.equal(view.provenance.inspection,'unavailable');assert(BigInt(view.provenance.returnedBytes)>0n);assert.equal(view.provenance.sourceBodyHash,payload.input.sha256);assert.equal(view.observation.phase,'quarantined');
  const added=(await readdir(evidence.directory)).filter(name=>!records.has(name)&&name.endsWith('.json')).map(name=>evidence.inspect(name.slice(0,-5))).filter(record=>record.attemptId===payload.attemptId&&record.direction==='response'&&record.recordId!==source.recordId);
  assert.equal(added.length,1);prefix=added[0];assert.equal(prefix.completeness,'partial');assert.equal(prefix.receivedBytes,view.provenance.returnedBytes);
  assert(store.db.prepare('SELECT 1 FROM roots WHERE owner=? AND hash=?').get('candidate-provenance:'+payload.attemptId,view.provenance.privacyPolicy.hash));
  assert.throws(()=>store.candidates.prompt(payload.jobId,payload.attemptId,'returned','0'),error=>['NOT_FOUND','CONTENT_WITHHELD'].includes(error.code));
 }else{
  assert.equal(view.provenance.complete,true);assert.equal(view.provenance.returnedBytes,String(expectedBytes));assert.equal(view.provenance.returnedPrompt.hash,expectedHash);
  assert.equal(view.items.length,1);assert.equal(view.items[0].safety,'safe');assert.equal(view.provenance.inspection,'opaque');
  const owned=view.provenance.returnedPrompt;assert(store.db.prepare('SELECT 1 FROM roots WHERE owner=? AND hash=?').get('candidate-provenance:'+payload.attemptId,owned.hash));store.objects.verify(owned);assert.deepEqual(store.objects.reservationInventory(),{reservedBytes:'0',activeTransfers:0});
 }
 return {phases,source,view,prefix:prefix??null,seededAcknowledgement:true,seededTerminalStatus:seededStatus};
 } catch(error) { return {phases,error:{name:error.name,code:error.code??null,message:String(error.message)}}; }
}
export async function compositionState(store,payload,context){
 assert(typeof payload.documentId==='string');const state=store.histories.state(payload.documentId);
 const [api,core]=await Promise.all([product(context,'server/storage/composition.js'),product(context,'src/composition/core.js')]);
 let result;
 // The graph read and copied bounded response are built while the real graph
 // allowance is live; the existing mailbox owns the bounded returned DTO.
 store.rasters.compositionMemory.compositions([state.composition],()=>{
  const graph=state.composition?api.readComposition(state.composition,ref=>store.objects.verify(ref,true)):null,bindings=state.composition?.bindings??{},staleNativeLinks=[];
  // LayerValues borrow decoded native text only during this synchronous check.
  // Return copied facts, never the borrowed projection or native text array.
  api.withLayerValues(state,ref=>store.objects.verify(ref,true),id=>store.assets.asset(id),store.rasters.compositionMemory,layers=>{
   for(const element of graph?.elements??[])for(const field of ['text','desc','bounds']){
    const binding=element[field];if(binding?.mode!=='layer')continue;
    const layer=layers.find(value=>value.id===bindings[binding.layerId]);
    if(field==='text'&&layer?.kind==='text'&&core.fieldStatus(binding,layers,bindings)==='stale'&&BigInt(layer.version)>BigInt(binding.lastReviewedLayerVersion))staleNativeLinks.push({elementId:element.id,field,binding:structuredClone(binding),layerId:layer.id,version:layer.version});
   }
  });
  result={graph,staleNativeLinks};assert(Buffer.byteLength(JSON.stringify(result))<60*1024,'Bounded semantic-link result required');
 });
 return result;
}

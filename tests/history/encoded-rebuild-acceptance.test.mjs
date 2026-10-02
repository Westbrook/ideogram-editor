import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {rootFor,command,pair,call,cookieFrom,readHeaders,mutationHeaders} from '../protocol/helpers.mjs';
import {importRaster,operate,terminal} from '../raster/helpers.mjs';
import {upload,copy,preview as previewCopy,workspace} from '../portable/helpers.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {newDraft,bindRequestMask,confirmRequestMask} from '../../dist/local/src/request/core.js';
import {canonical} from '../../dist/local/src/protocol/json.js';

const document=async(f,id='document_1')=>(await f.read('/api/v1/documents/'+id)).json.projection.value;
const image=async(f,id='document_1')=>(await f.read('/api/v1/documents/'+id+'/image')).json;
async function retained(f,ref){
  const bytes=await readFile(join(f.root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7)));
  assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),ref.hash);
  assert.equal(String(bytes.length),ref.byteLength);return bytes;
}
async function pixels(f,id){return retained(f,(await f.read('/api/v1/assets/'+id)).json.projection.value.raster.pixels);}
// HTTP deliberately has no complete asset inventory. Read-only storage snapshots
// catch eager Q, wrapper and composite registration, including invisible assets.
function inventory(f){
  const db=new DatabaseSync(join(f.root,'metadata.sqlite'),{readOnly:true});
  try{return {
    assets:db.prepare('SELECT id,json FROM assets ORDER BY id').all(),
    previews:db.prepare('SELECT id,json FROM image_previews ORDER BY id').all(),
    history:db.prepare('SELECT id,json FROM history ORDER BY id').all(),
    rasterRoots:db.prepare("SELECT DISTINCT hash,media_type FROM roots WHERE media_type IN ('application/x-ideogram-rgba8','image/png','image/jpeg') ORDER BY hash,media_type").all(),
  };}finally{db.close();}
}
async function events(f,receipt){
  const response=await f.read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n));
  assert.equal(response.status,200,response.text);const batch=response.json.batches[0];
  if(batch.kind==='inline')return batch.events;
  const content=await f.read(batch.content.url);assert.equal(content.status,200,content.text);
  assert.equal('sha256:'+createHash('sha256').update(content.text).digest('hex'),batch.content.blob.hash);
  return content.text.split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
async function submit(f,body,id,revision){
  const request=f.command({documentId:id,expectedDocumentRevision:revision,body}),result=await terminal(f,request);
  return {request,result,receipt:result.json.receipt};
}
async function run(f,body,id='document_1'){
  const value=await submit(f,body,id,(await document(f,id)).revision);
  assert.equal(value.receipt.status,'accepted',value.result.text);
  return {...value,events:await events(f,value.receipt),document:await document(f,id)};
}
async function layer(f,id,fixture){
  const {asset}=await importRaster(f,fixture);
  await run(f,{type:'ImportAsset',assetId:asset.id,layerId:id,name:id,draft:null});
}
async function properties(f,id,value){
  const current=(await image(f)).layers.find(layer=>layer.id===id);
  return run(f,{type:'SetLayerProperties',layerId:id,layerVersion:current.version,properties:value,draft:null});
}
async function source(f){
  const before=await document(f),captured=await run(f,{type:'PrepareRequestSource',scope:'visible-document',layerIds:[]}),asset=captured.events[0].payload.asset;
  assert.deepEqual(await document(f),before);
  return {assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:512,height:512,scope:'visible-document',documentRevision:before.revision,capture:asset.raster.manifest};
}
// Only the provider boundary is substituted. Commands, retained raster inputs,
// queue admission, result decoding, review and history all use the real server.
async function fixture(t,failure=false,hold=false){
  const mode='inpaint';
  // Provider teardown records its final resource state inside this root.
  let server;t.after(()=>server?.close());
  const root=await rootFor(t),module='./encoded-rebuild-guard-fixture.mjs';
  await writeFile(join(root,'encoded-guard-config.json'),JSON.stringify({failure,hold}),{flag:'wx',mode:0o600});
  server=await startLocalServer({root},{writer:{setupModule:new URL(module,import.meta.url).href}});
  const paired=await pair(server);assert.equal(paired.status,200,paired.text);
  const f={root,server,paired,
    read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))}),
    post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),
    command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body),
    effects:async()=>{const value=JSON.parse(await readFile(join(root,mode==='inpaint'?'request-edits-fixture.json':'candidate-fixture.json'),'utf8'));assert.deepEqual(value.errors,[]);return value.effects;},
  };
  assert.equal((await terminal(f,f.command({}, {width:512,height:512}))).json.receipt.status,'accepted');return f;
}
async function caption(f,text){
  const staged=await upload(f,Buffer.from(text),'caption','text/plain');
  return (await operate(f,{type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256})).event.payload.asset;
}
async function ui(f,body){
  const sessionId='deferred_adoption',current=(await f.read('/api/v1/ui/'+sessionId)).json;
  const request={protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:current.uiSeq,body};
  const result=await f.post('/api/v1/ui/'+sessionId,request);assert.equal(result.json.status,'accepted',result.text);
  return {request,value:result.json};
}
async function candidate(f,captured=null){
  const prompt=await caption(f,'Cold deferred placement fixture'),draft=newDraft(prompt.blob);
  Object.assign(draft.fields,{width:'512',height:'512'});
  if(captured){
    const asset=(await operate(f,{type:'PrepareRequestMask',sourceAssetId:captured.assetId,plan:{width:512,height:512,feather:0,operations:[{kind:'shape',shape:{kind:'rectangle',x:1,y:1,width:1,height:1},mode:'replace'}]},clip:null})).event.payload.asset;
    const manifest=(await f.read('/api/v1/assets/'+asset.id+'/raster')).json;
    const mask={assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:512,height:512,sourceHash:captured.pixels.hash,polarity:'white-edit',fullAcknowledged:false,empty:false,full:false,plan:asset.raster.manifest,binding:bindRequestMask(captured)};
    mask.requestPlan=confirmRequestMask(captured,mask,manifest.plan.hard,manifest.plan.effective,randomUUID());
    draft.operation='inpaint';draft.fields.size='auto';draft.fields.strength='1';draft.source=captured;draft.mask=mask;
  }
  const draftBytes=JSON.stringify(draft);assert.notEqual(draftBytes,canonical(draft),'Saved authored JSON deliberately uses noncanonical key order');
  const saved=await caption(f,draftBytes);
  await ui(f,{type:'SaveDraft',draft:{id:'request',generation:'1',kind:'request',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:(await document(f)).revision,assetId:saved.id,composing:false}});
  const reviewed=await ui(f,{type:'PrepareRequestReview',draftId:'request',generation:'1'}),review=reviewed.value.review;
  const accepted=await ui(f,{type:'AcceptRequestReview',reviewId:review.id,token:review.token});
  const queued=await operate(f,{type:'QueueInference',reviewId:review.id,token:review.token,acceptanceId:accepted.request.requestId}),jobId=queued.event.payload.id;
  let value;const deadline=Date.now()+20000;
  do{
    const response=await f.read('/api/v1/jobs/'+jobId+'/candidates');if(response.status===200)value=response.json.items[0];
    if(value?.state==='prepared')break;await new Promise(resolve=>setTimeout(resolve,25));
  }while(Date.now()<deadline);
  assert.equal(value?.state,'prepared',JSON.stringify(value));return {value,draft,saved,draftBytes};
}
const placement=(candidate,patch={})=>({type:'ReviewCandidatePlacement',candidateId:candidate.id,mode:'safe-region',placement:'current-document',newDocumentId:null,actualOutput:null,newLayerId:randomUUID(),name:'Encoded candidate',preparation:'encoded-rebuild',...patch});
const adoption=review=>({type:'AdoptReviewedCandidate',reviewId:review.reviewId,reviewHash:review.reviewHash,draft:null});
async function review(f,body){
  const before=await document(f),beforeImage=await image(f),cold=inventory(f);
  const result=await run(f,body);assert.deepEqual(result.events.map(event=>event.type),['CandidatePlacementReviewPrepared']);
  assert.equal(result.receipt.documentRevision,before.revision);assert.deepEqual(await document(f),before);assert.deepEqual(await image(f),beforeImage);
  assert.deepEqual(inventory(f),cold,'Review must not create Q, a wrapper, a composite, a preview or history');
  const identity=result.events[0].payload,response=await f.read('/api/v1/image-edit-reviews/'+identity.reviewId);
  assert.equal(response.status,200,response.text);const value=response.json,{type,preparation,...expectedPlacement}=body;
  assert.equal(value.kind,'candidate-placement-review-1');assert.equal(value.protocolVersion,1);
  assert.equal(value.reviewId,identity.reviewId);assert.equal(value.reviewHash,identity.reviewHash);
  assert.equal(value.targetClientId,f.paired.json.clientId);assert.equal(value.documentId,before.id);assert.equal(value.documentRevision,before.revision);
  assert.deepEqual(value.placement,expectedPlacement);assert.equal(value.width,512);assert.equal(value.height,512);
  assert.equal(value.preparation,'deferred');assert.equal(value.inputs.encodedRebuild.kind,'encoded-adoption-inputs-1');assert.equal(value.inputs.kind,'candidate-adoption-inputs-1');assert.equal(value.inputs.mode,body.mode);
  assert.equal(value.inputs.identity.candidateId,body.candidateId);assert.equal('preview' in value,false);
  if(before.image)assert.deepEqual(value.source,before.image);
  else {assert.equal(value.source.compositeAssetId,null);assert.deepEqual(JSON.parse(await retained(f,value.source.state)),beforeImage);}
  return value;
}
async function accept(f,review){
  const id=review.placement.placement==='new-document'?review.placement.newDocumentId:review.documentId;
  const revision=review.placement.placement==='new-document'?null:(await document(f,id)).revision;
  const value=await submit(f,adoption(review),id,revision);assert.equal(value.receipt.status,'accepted',value.result.text);
  const committed=await events(f,value.receipt),finalType=review.placement.placement==='new-document'?'DocumentCreated':'ImageEdited';
  assert.equal(committed.at(-1).type,finalType);assert(committed.length>=3,'Prepared assets and the placement commit share one transaction');
  for(const event of committed)assert.equal(event.transactionId,value.request.command.transactionId);
  assert(committed.slice(0,-1).every(event=>event.type==='AssetRegistered'));
  assert(committed.slice(0,-1).every(event=>event.documentId===null));assert.equal(committed.at(-1).documentId,id);
  return {...value,events:committed,document:await document(f,id)};
}
async function rejected(f,body,code,id='document_1',revision=undefined){
  const before=await document(f),cold=inventory(f),targetBefore=await f.read('/api/v1/documents/'+id);
  const expected=revision===undefined?targetBefore.json.projection.value.revision:revision;
  const value=await submit(f,body,id,expected);assert.equal(value.receipt.status,'rejected',value.result.text);assert.equal(value.receipt.code,code,value.result.text);
  assert.deepEqual(await document(f),before);assert.deepEqual(inventory(f),cold);
  const targetAfter=await f.read('/api/v1/documents/'+id);assert.equal(targetAfter.status,targetBefore.status);
  if(targetBefore.status===200)assert.deepEqual(targetAfter.json.projection.value,targetBefore.json.projection.value);
  return value.receipt;
}

async function observation(f,commandId){
 const deadline=Date.now()+5000;
 for(;;){
  try{const value=JSON.parse(await readFile(join(f.root,'encoded-guard-observation.json'),'utf8'));if(value.commands.some(row=>row.commandId===commandId))return value;}catch(error){if(error.code!=='ENOENT')throw error;}
  assert(Date.now()<deadline,'Owning writer cleanup observation must become available within the bounded polling window');
  await new Promise(resolve=>setTimeout(resolve,10));
 }
}
function released(value){
 assert.deepEqual(value.violations,[],'Old raw content reads and retained-Q lookups are forbidden after explicit acceptance');
 assert(value.guarded.length>0,'The negative read guard must cover real retained canonical inputs');
 assert.deepEqual(value.leases,{leases:0,proofs:0,metadataBytes:0});
 assert.deepEqual(value.proofs,{pending:0,retained:0,activeReaders:0,metadataBytes:0});
 assert(value.workRemoved.every(Boolean),'Every encoded worker directory must be removed after terminal cleanup');
 assert.equal(value.raster.activeWorkers,0);assert.equal(value.raster.reservedCPU,0);
}
async function seedEncoded(t,failure=false,hold=false){
 const f=await fixture(t,failure,hold);await layer(f,'picture','hidden-alpha.png');
 const captured=await source(f),{value:c}=await candidate(f,captured),approved=await review(f,placement(c));
 return {f,c,approved};
}

test('encoded acceptance uses genuine held proofs with no old raw content reads or retained Q, and records all fresh decodes',async t=>{
 const {f,approved}=await seedEncoded(t),original=await pixels(f,(await document(f)).image.compositeAssetId),coverage=await retained(f,approved.inputs.encodedRebuild.mask.approved.pixels);
 const committed=await accept(f,approved),value=await observation(f,committed.request.command.commandId);released(value);
 const slot='history:'+committed.request.command.commandId,records=value.observations.filter(row=>row.slot===slot);
 assert.deepEqual(records.map(row=>row.operation),['encoded-preserve','encoded-compose']);
 assert.deepEqual(value.workerJobs,[{type:'encoded-preserve',slot},{type:'encoded-compose',slot}]);
 assert.deepEqual(records.map(row=>row.evidence.decodeCount),[5,1]);
 const inputs=approved.inputs.encodedRebuild;
 assert.deepEqual(records[0].evidence.inputs.map(input=>input.encoded),[inputs.source.encoded,inputs.candidate.encoded,inputs.mask.authored.encoded,inputs.mask.effective.encoded,inputs.mask.approved.encoded]);
 for(const row of records){
  assert.equal(row.documentId,approved.documentId);assert.equal(row.evidence.kind,'encoded-input-rebuild-1');
  assert.equal(row.evidence.canonicalInputPaths,0);assert.equal(row.evidence.reusedPreparedProducts,0);assert.equal(row.evidence.scratchRemoved,true);
  for(const input of row.evidence.inputs)assert.deepEqual(input.actual,input.expected);
 }
 assert.deepEqual(records[1].evidence.inputs[0].encoded,records[0].output.encoded);assert.deepEqual(records[1].evidence.inputs[0].expected,records[0].output.pixels);
 assert.equal(records[1].outputAssetId,committed.document.image.compositeAssetId);
 const output=await pixels(f,committed.document.image.compositeAssetId);
 for(let at=0;at<coverage.length;at+=2)if(coverage.readUInt16LE(at)===0)assert.deepEqual(output.subarray(at*2,at*2+4),original.subarray(at*2,at*2+4));
 assert.deepEqual([...output.subarray((512+1)*4,(512+2)*4)],[36,104,172,255]);
 assert.deepEqual(await retained(f,inputs.source.info.pixels),original,'Original canonical bytes remain retained');
});

test('failure after encoded preservation rolls back the document and cannot fall back after consuming its proof lease',async t=>{
 const {f,approved}=await seedEncoded(t,true),before=await document(f),cold=inventory(f);
 const attempted=await submit(f,adoption(approved),'document_1',before.revision);
 assert.equal(attempted.receipt.status,'rejected',attempted.result.text);assert.equal(attempted.receipt.code,'INVALID_INPUT');
 assert.deepEqual(await document(f),before);assert.deepEqual(inventory(f),cold,'Fresh work files may be collected, but no asset or history root is committed');
 const value=await observation(f,attempted.request.command.commandId);released(value);
 assert.deepEqual(value.observations.map(row=>row.operation),['encoded-preserve']);
 const retry=await submit(f,adoption(approved),'document_1',before.revision);
 assert.equal(retry.receipt.status,'rejected',retry.result.text);assert.equal(retry.receipt.code,'STALE_REVISION');
 assert.equal(JSON.parse(await retained(f,retry.receipt.details)).issues[0].code,'ENCODED_REBUILD_REVIEW_REQUIRED');
 const retried=await observation(f,retry.request.command.commandId);released(retried);
 assert.equal(retried.observations.length,1,'Missing lease must fail before dispatching another decode');
 assert.deepEqual(await document(f),before);assert.deepEqual(inventory(f),cold);
});

test('a public owner read observes real in-flight acceptance after lease consumption without renewing or raw fallback',async t=>{
 const {f,approved}=await seedEncoded(t,false,true),before=await document(f);
 const request=f.command({documentId:before.id,expectedDocumentRevision:before.revision,body:adoption(approved)});
 const admitted=await f.post('/api/v1/commands',request);assert.equal(admitted.status,202,admitted.text);
 const deadline=Date.now()+5000;let held;
 try{
  for(;;){try{held=JSON.parse(await readFile(join(f.root,'encoded-acceptance-held.json'),'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;}assert(Date.now()<deadline,'Real history acceptance must consume the lease before worker preservation');await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(held.commandId,request.command.commandId);assert.deepEqual(held.leases,{leases:0,proofs:0,metadataBytes:0});assert(held.proofs.retained>0);
  for(let index=0;index<2;index++){
   const read=await f.read('/api/v1/image-edit-reviews/'+approved.reviewId);assert.equal(read.status,200,read.text);assert.deepEqual(read.json,approved);
   const observed=JSON.parse(await readFile(join(f.root,'encoded-acceptance-held.json'),'utf8'));assert.equal(observed.liveReadCount,index+1);assert.deepEqual(observed.leases,held.leases);assert.deepEqual(observed.proofs,held.proofs,'Public owner reads cannot recreate a consumed lease or change active proof ownership');
  }
 }finally{await writeFile(join(f.root,'encoded-acceptance-release'),'release',{mode:0o600});}
 const completed=await terminal(f,request);assert.equal(completed.json.receipt.status,'accepted',completed.text);
 const value=await observation(f,request.command.commandId);released(value);assert.deepEqual(value.observations.map(row=>row.evidence.decodeCount),[5,1]);
});

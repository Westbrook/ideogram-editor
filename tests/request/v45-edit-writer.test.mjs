// Staged writer regressions; run only after the coordinated overlay is promoted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setup,call,mutationHeaders} from '../protocol/helpers.mjs';
import {operate,terminal,importRaster,envelope} from '../raster/helpers.mjs';
import {doc,edit} from '../portable/helpers.mjs';
import {hash,bindRequestMask,confirmRequestMask} from '../../dist/local/src/request/core.js';
import {newV45EditDraft} from '../../dist/local/src/request/family.js';
import {openWriter} from '../../dist/local/server/storage/writer.js';

const session='v45_edit_session',draftId='v45_edit_draft';
const prompt='Keep this exact lettering: Café 東京\n';
const objectPath=(root,ref)=>join(root,'objects/sha256',ref.hash.slice(7,9),ref.hash.slice(7));
const objectText=(f,ref)=>readFile(objectPath(f.root,ref),'utf8');
const draftPath=generation=>'/api/v1/ui/'+session+'/request?draftId='+draftId+'&generation='+generation;
async function caption(f,text){
 const bytes=Buffer.from(text),stagingId=randomUUID(),sha256=hash(text);
 const created=await f.post('/api/v1/assets/staging',{protocolVersion:1,stagingId,purpose:'caption',expectedBytes:String(bytes.length),sha256,mediaType:'text/plain'});
 assert.equal(created.status,201,created.text);
 const written=await call(f.server.origin,'/api/v1/assets/staging/'+stagingId,{method:'PUT',raw:bytes,headers:{...mutationHeaders(f.server,f.paired),'Content-Type':'application/octet-stream','Upload-Offset':'0'}});
 assert.equal(written.status,200,written.text);
 return (await operate(f,{type:'FinalizeStaging',stagingId,expectedSha256:sha256})).event.payload.asset;
}
async function send(f,body){
 const ui=(await f.read('/api/v1/ui/'+session)).json;
 const request={protocolVersion:1,requestId:randomUUID(),sessionId:session,expectedUISeq:ui.uiSeq,body};
 return {request,result:await f.post('/api/v1/ui/'+session,request)};
}
async function save(f,draft,generation='1'){
 const asset=await caption(f,JSON.stringify(draft)),document=await doc(f);
 const saved=await send(f,{type:'SaveDraft',draft:{id:draftId,generation,kind:'request',documentId:document.id,targetLayerId:null,expectedDocumentRevision:document.revision,assetId:asset.id,composing:false}});
 assert.equal(saved.result.status,200,saved.result.text);assert.equal(saved.result.json.status,'accepted',saved.result.text);
 const retained=await f.read(draftPath(generation));assert.equal(retained.status,200,retained.text);assert.deepEqual(retained.json.value,draft);
 const content=await f.read(draftPath(generation)+'&content=1');assert.equal(content.status,200,content.text);assert.equal(content.text,prompt);assert.equal(content.headers.etag,'"'+draft.prompt.text.hash+'"');assert.equal(content.headers['content-length'],draft.prompt.text.byteLength);
 return saved;
}
async function review(f,generation='1'){
 const result=await send(f,{type:'PrepareRequestReview',draftId,generation});
 assert.equal(result.result.status,200,result.result.text);assert.equal(result.result.json.status,'accepted',result.result.text);
 return result.result.json.review;
}
async function accept(f,review){
 const result=await send(f,{type:'AcceptRequestReview',reviewId:review.id,token:review.token});
 assert.equal(result.result.json.status,'accepted',result.result.text);assert.equal(result.result.json.acceptedReview,review.id);
 return result;
}
const queueBody=(review,accepted)=>({type:'QueueInference',reviewId:review.id,token:review.token,acceptanceId:accepted.request.requestId});
async function queueView(f){const result=await f.read('/api/v1/queue');assert.equal(result.status,200,result.text);return result.json;}
async function capture(f,scope){
 const before=await doc(f),result=await edit(f,{type:'PrepareRequestSource',scope,layerIds:scope==='visible-document'?[]:['picture']});
 assert.equal(result.event.type,'AssetRegistered');assert.deepEqual(await doc(f),before);
 const asset=result.event.payload.asset,response=await f.read('/api/v1/assets/'+asset.id+'/raster');assert.equal(response.status,200,response.text);
 const source={assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:asset.raster.width,height:asset.raster.height,scope,documentRevision:before.revision,capture:asset.raster.manifest};
 assert.equal(response.json.plan.kind,'request-source-capture-v1');assert.equal(response.json.plan.capture.scope,scope);assert.deepEqual(response.json.pixels,source.pixels);
 return source;
}
function descriptor(asset){return {blob:asset.blob,pixels:asset.raster.pixels,manifest:asset.raster.manifest,pixelIdentity:asset.raster.pixelIdentity,width:asset.raster.width,height:asset.raster.height};}
async function fixture(t,masked=true){
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));
 const {asset:original}=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:original.id,layerId:'picture',name:'Picture',draft:null});
 const source=await capture(f,'single-layer'),a=await capture(f,'selected-layers'),b=await capture(f,'visible-document');
 assert.notEqual(a.assetId,b.assetId);
 const references=masked?[a,b,a]:[a,b,a,b];
 let mask=null;
 if(masked){
  const prepared=await operate(f,{type:'PrepareRequestMask',sourceAssetId:source.assetId,plan:{width:3,height:2,feather:0,operations:[{kind:'shape',shape:{kind:'rectangle',x:1,y:0,width:1,height:2},mode:'replace'}]},clip:null});
  assert.equal(prepared.event.type,'AssetRegistered');const asset=prepared.event.payload.asset,response=await f.read('/api/v1/assets/'+asset.id+'/raster');assert.equal(response.status,200,response.text);
  const manifest=response.json;assert.equal(manifest.plan.kind,'authored-request-mask-v1');assert.equal(manifest.plan.sourceAssetId,source.assetId);assert.deepEqual(manifest.plan.source,source.capture);
  mask={assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:3,height:2,sourceHash:source.pixels.hash,polarity:'white-edit',fullAcknowledged:false,empty:false,full:false,plan:asset.raster.manifest,binding:bindRequestMask(source)};
  mask.requestPlan=confirmRequestMask(source,mask,manifest.plan.hard,manifest.plan.effective,'v45_edit_writer_mapping');
 }
 const document=await doc(f),body={type:'PrepareV45EditInputs',source,mask,references},prepared=await operate(f,body);
 assert.equal(prepared.event.type,'AssetRegistered');assert.deepEqual(prepared.command.command.body,body);assert.deepEqual(await doc(f),document);
 const asset=prepared.event.payload.asset,response=await f.read('/api/v1/assets/'+asset.id+'/raster');assert.equal(response.status,200,response.text);
 const manifest=response.json,plan=manifest.plan;
 assert.equal(plan.kind,'v45-edit-inputs-1');assert.equal(plan.endpoint,'ideogram/v4.5/edit');assert.deepEqual(plan.original,{source,mask});assert.deepEqual(plan.requestPlan,mask?.requestPlan??null);
 assert.deepEqual(plan.assetBindings,{source:source.assetId,mask:mask?.assetId??null,references:references.map(value=>value.assetId)});
 assert.deepEqual(plan.references.map(value=>value.original),references);assert.deepEqual(plan.references[0],plan.references[2]);
 assert.deepEqual(asset.raster.sourceAssetIds,[source.assetId,...(mask?[mask.assetId]:[]),a.assetId,b.assetId]);
 assert.deepEqual(manifest.pixels,asset.raster.pixels);
 if(masked){assert.equal(plan.mask.polarity,'black-edit');assert.equal(plan.mask.editPixels,2);assert.equal(plan.mask.keepPixels,4);assert.deepEqual(plan.mask.sourcePixels,asset.raster.pixels);assert.notEqual(plan.mask.blob.hash,mask.blob.hash);}
 else{assert.equal(plan.mask,null);assert.deepEqual(asset.raster.pixels,source.pixels);}
 const text=await caption(f,prompt),draft=newV45EditDraft(text.blob,masked?'inpaint-v45':'transform-v45');
 Object.assign(draft,{source,mask,references,preparedInputs:{assetId:asset.id,version:asset.version,manifest:asset.raster.manifest,source:descriptor(asset),mask:plan.mask,references:plan.references.map(value=>value.input)}});
 Object.assign(draft.fields,{count:'2',seed:'900719925474099312345'});
 return {f,draft,prepared,manifest,document};
}

for(const masked of [true,false])test('real V45 '+(masked?'masked':'regular')+' writer freezes prepared inputs and repeated reference roles through local queue and restart',async t=>{
 const {f,draft,prepared,manifest,document}=await fixture(t,masked);await save(f,draft);
 const reviewed=await review(f),accepted=await accept(f,reviewed),request=reviewed.request;
 assert.equal(reviewed.kind,'request-review-v45-1');assert.equal(reviewed.endpoint,'ideogram/v4.5/edit');assert.equal(reviewed.dispatch,false);
 assert.equal(request.kind,masked?'inpaint-v45':'transform-v45');assert.deepEqual(request.source,draft.source);assert.deepEqual(request.references,draft.references);assert.deepEqual(request.preparedInputs,draft.preparedInputs);
 assert.equal(Object.hasOwn(request,'mask'),masked);if(masked)assert.deepEqual(request.mask,draft.mask);
 assert.equal(Object.hasOwn(request.modelRequest,'source'),false);assert.equal(Object.hasOwn(request.modelRequest,'mask'),false);assert.equal(Object.hasOwn(request.modelRequest,'references'),false);assert.equal(Object.hasOwn(request.modelRequest,'seed'),false);
 for(const key of ['prompt','image_url','mask_url','reference_image_urls'])assert.equal(Object.hasOwn(request.modelRequest.body,key),false);
 const template=await objectText(f,reviewed.template),wire=JSON.parse(template),{seed,...body}=wire;
 assert.deepEqual(body,{prompt,image_url:'asset:'+draft.preparedInputs.source.blob.hash,...(masked?{mask_url:'asset:'+draft.preparedInputs.mask.blob.hash}:{}),reference_image_urls:draft.preparedInputs.references.map(value=>'asset:'+value.blob.hash),image_size:'auto',edit_precision:masked?'high':'regular',quality:'medium',num_images:2,sync_mode:false});
 assert.match(template,/"seed":900719925474099312345(?:,|})/);assert.equal(await objectText(f,reviewed.prompt),prompt);
 assert.equal(reviewed.providerReview.resultContract,'ideogram-v45-result-1');assert.equal(reviewed.providerReview.admission.policy,'unknown-withheld-1');assert.equal(reviewed.providerReview.admission.state,'blocked');assert.equal(reviewed.providerReview.privacyProfile,null);assert.equal(reviewed.providerReview.dispatch,false);
 const queued=await operate(f,queueBody(reviewed,accepted));assert.equal(queued.event.type,'JobQueued');
 const view=await queueView(f),job=view.jobs.find(value=>value.id===queued.event.payload.id);assert(job);assert.deepEqual(job.review,reviewed);
 const roles=['source',...(masked?['mask']:[]),...draft.references.map((_,index)=>'reference:'+index)];assert.deepEqual(job.stagePlan.map(value=>value.role),roles);
 const originals=[draft.source,...(masked?[draft.mask]:[]),...draft.references],inputs=[draft.preparedInputs.source,...(masked?[draft.preparedInputs.mask]:[]),...draft.preparedInputs.references];
 for(const [index,stage]of job.stagePlan.entries())assert.deepEqual(stage,{kind:'v45-prepared-stage-1',role:roles[index],assetId:originals[index].assetId,assetVersion:originals[index].version,original:originals[index].blob,transport:inputs[index].blob,width:inputs[index].width,height:inputs[index].height,conversion:null,prepared:inputs[index]});
 assert.equal(view.production,'denied');assert.deepEqual(view.counts,{reserved:0,dispatched:0,remaining:null,active:0});assert.equal(job.local,'accepted-local-queue');assert.equal(job.attempts[0].state,'not-started');assert.equal(job.attempts[0].count,'none');assert.equal(job.attempts[0].hold,false);assert.equal(job.attempts[0].providerAuthorization,undefined);
 const denied=await terminal(f,envelope(f,{type:'AuthorizeProviderJob',jobId:job.id,attemptId:job.attempts[0].id,expectedVersion:job.version,reviewToken:reviewed.token,configurationId:'fixture_configuration',configurationHash:'a'.repeat(64),epoch:randomUUID(),profileId:'fixture_profile',profileVersion:1,disclosureDigest:'b'.repeat(64),acknowledgeChargeAndPrivacy:true}));
 assert.equal(denied.json.receipt.status,'rejected');assert.equal(denied.json.receipt.code,'INCOMPATIBLE');assert.equal(JSON.parse(await objectText(f,denied.json.receipt.details)).issues[0].code,'V45_SAFETY_ADMISSION_BLOCKED');
 assert.deepEqual(await queueView(f),view);assert.deepEqual(await doc(f),document);assert.deepEqual((await f.read('/api/v1/assets/'+prepared.event.payload.asset.id+'/raster')).json,manifest);
 assert.deepEqual((await terminal(f,queued.command)).json.receipt,queued.receipt);assert.deepEqual((await f.post('/api/v1/ui/'+session,accepted.request)).json,accepted.result.json);
 const checkpoint=(await f.read('/api/v1/ui/'+session)).json;
 await f.server.close();const writer=await openWriter({root:f.root});t.after(()=>writer.close());
 const auth={clientId:f.paired.json.clientId,sessionHash:'c'.repeat(64),now:Date.now(),expires:Date.now()+1800000};
 assert.deepEqual(await writer.queueView(),view);assert.deepEqual(await writer.uiRead(session,auth),checkpoint);assert.deepEqual(await writer.rasterManifest(prepared.event.payload.asset.id),manifest);
 assert.equal(await writer.queueReserve(job.id),null);assert.deepEqual(await writer.queueView(),view);
 assert.deepEqual(await writer.queueCommand(Buffer.from(JSON.stringify(queued.command)),auth),queued.receipt);assert.deepEqual(await writer.uiPersist(Buffer.from(JSON.stringify(accepted.request)),auth),accepted.result.json);
 const renewed={...accepted.request,requestId:randomUUID(),expectedUISeq:checkpoint.uiSeq},stale=await writer.uiPersist(Buffer.from(JSON.stringify(renewed)),auth);assert.equal(stale.status,'rejected');assert.match(stale.reason,/STALE_REVIEW/);
});

const changes=[
 ['source version',draft=>{draft.source.version='999';},/V45_INPUTS_CHANGED/],
 ['prepared mask measurements',draft=>{draft.preparedInputs.mask.editPixels++;draft.preparedInputs.mask.keepPixels--;},/V45_INPUTS_CHANGED/],
 ['reference order',draft=>{[draft.references[0],draft.references[1]]=[draft.references[1],draft.references[0]];[draft.preparedInputs.references[0],draft.preparedInputs.references[1]]=[draft.preparedInputs.references[1],draft.preparedInputs.references[0]];},/V45_INPUTS_CHANGED/],
];
for(const [label,change,reason]of changes)test('changed '+label+' after preparation rejects fresh review and old acceptance while retaining the exact draft',async t=>{
 const {f,draft,prepared,manifest,document}=await fixture(t);await save(f,draft);const first=await review(f),accepted=await accept(f,first),changed=structuredClone(draft);change(changed);await save(f,changed,'2');
 const result=await send(f,{type:'PrepareRequestReview',draftId,generation:'2'});assert.equal(result.result.json.status,'rejected',result.result.text);assert.match(result.result.json.reason,reason);
 const stale=await send(f,{type:'AcceptRequestReview',reviewId:first.id,token:first.token});assert.equal(stale.result.json.status,'rejected');assert.match(stale.result.json.reason,/STALE_REVIEW/);
 const queued=await terminal(f,envelope(f,queueBody(first,accepted)));assert.equal(queued.json.receipt.status,'rejected');assert.equal(queued.json.receipt.code,'STALE_REVISION');assert.match(JSON.parse(await objectText(f,queued.json.receipt.details)).issues[0].code,/STALE_REVIEW/);
 assert.deepEqual((await f.read(draftPath('2'))).json.value,changed);assert.equal((await f.read(draftPath('2')+'&content=1')).text,prompt);assert.equal((await f.read('/api/v1/ui/'+session)).json.drafts[0].generation,'2');
 assert.deepEqual((await f.read('/api/v1/assets/'+prepared.event.payload.asset.id+'/raster')).json,manifest);assert.deepEqual(await doc(f),document);assert.equal((await queueView(f)).totalJobs,0);
 // The durable rejection receipt is replayable without replacing retained input.
 assert.deepEqual((await f.post('/api/v1/ui/'+session,result.request)).json,result.result.json);
});

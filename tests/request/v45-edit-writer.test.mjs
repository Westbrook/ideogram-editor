// Staged writer regressions; run only after the coordinated overlay is promoted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {inflateSync,crc32} from 'node:zlib';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {setup,call,mutationHeaders} from '../protocol/helpers.mjs';
import {operate,terminal,importRaster,envelope} from '../raster/helpers.mjs';
import {doc,edit} from '../portable/helpers.mjs';
import {hash,bindRequestMask,confirmRequestMask} from '../../dist/local/src/request/core.js';
import {newV45EditDraft} from '../../dist/local/src/request/family.js';
import {openWriter} from '../../dist/local/server/storage/writer.js';
import {StoreDatabase} from '../../dist/local/server/storage/database.js';
import {acquireRoot} from '../../dist/local/server/storage/ownership.js';
import {createV45LoopbackEdit,createV45LoopbackGeneration} from '../../dist/local/server/provider/v45-loopback-fixture.js';

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
async function capture(f,scope,layerId='picture'){
 const before=await doc(f),result=await edit(f,{type:'PrepareRequestSource',scope,layerIds:scope==='visible-document'?[]:[layerId]});
 assert.equal(result.event.type,'AssetRegistered');assert.deepEqual(await doc(f),before);
 const asset=result.event.payload.asset,response=await f.read('/api/v1/assets/'+asset.id+'/raster');assert.equal(response.status,200,response.text);
 const source={assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:asset.raster.width,height:asset.raster.height,scope,documentRevision:before.revision,capture:asset.raster.manifest};
 assert.equal(response.json.plan.kind,'request-source-capture-v1');assert.equal(response.json.plan.capture.scope,scope);assert.deepEqual(response.json.pixels,source.pixels);
 return source;
}
function descriptor(asset){return {blob:asset.blob,pixels:asset.raster.pixels,manifest:asset.raster.manifest,pixelIdentity:asset.raster.pixelIdentity,width:asset.raster.width,height:asset.raster.height};}
async function fixture(t,masked=true,referenceMode='captures'){
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));
 const {asset:original}=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:original.id,layerId:'picture',name:'Picture',draft:null});
 if(referenceMode==='distinct')for(const name of ['black','white']){const {asset}=await importRaster(f,name+'.png');await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'reference_'+name,name:'Reference '+name,draft:null});}
 const source=await capture(f,'single-layer');let references=[];
 if(referenceMode!=='none'){
  const a=await capture(f,referenceMode==='distinct'?'single-layer':'selected-layers',referenceMode==='distinct'?'reference_black':'picture'),b=await capture(f,referenceMode==='distinct'?'single-layer':'visible-document',referenceMode==='distinct'?'reference_white':'picture');
  assert.notEqual(a.assetId,b.assetId);if(referenceMode==='distinct')assert.notEqual(a.pixels.hash,b.pixels.hash);
  references=masked?[a,b,a]:[a,b,a,b];
 }
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
 assert.deepEqual(plan.references.map(value=>value.original),references);if(references.length)assert.deepEqual(plan.references[0],plan.references[2]);
 assert.deepEqual(asset.raster.sourceAssetIds,[...new Set([source.assetId,...(mask?[mask.assetId]:[]),...references.map(value=>value.assetId)])]);
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

// These fixtures cross the actual owned preparation → upload → durable edit
// boundary. Their tiny local output stays unknown/withheld; no provider quality,
// live privacy, safe display, or adoption qualification is claimed.
const sentinel='fixture-key-never-production-P21',editSeed='900719925474099312345';
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const protectedPNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/mxQAAAAASUVORK5CYII=','base64');
function expectedEditWire(masked,urls,references){
 const body={prompt,image_url:urls.source,...(masked?{mask_url:urls.mask}:{}),...(references.length?{reference_image_urls:references.map((_,i)=>urls['reference:'+i])}:{}),image_size:'auto',edit_precision:masked?'high':'regular',quality:'medium',num_images:1,sync_mode:false};
 return Buffer.from('{'+[...Object.keys(body),'seed'].sort().map(key=>JSON.stringify(key)+':'+(key==='seed'?editSeed:JSON.stringify(body[key]))).join(',')+'}');
}
// The owned PNG encoder writes RGBA8/filter0. Decode the actual uploaded tiny
// PNG independently with zlib, including chunk CRCs and the literal cell oracle.
function tinyRGBA(bytes,width,height){
 assert.deepEqual(bytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));const data=[];let header=false,end=false;
 for(let at=8;at<bytes.length;){const n=bytes.readUInt32BE(at),type=bytes.toString('ascii',at+4,at+8);assert(at+n+12<=bytes.length);assert.equal(bytes.readUInt32BE(at+n+8),crc32(bytes.subarray(at+4,at+n+8)));
  const chunk=bytes.subarray(at+8,at+8+n);if(type==='IHDR'){assert.equal(header,false);header=true;assert.equal(chunk.readUInt32BE(0),width);assert.equal(chunk.readUInt32BE(4),height);assert.deepEqual([...chunk.subarray(8)],[8,6,0,0,0]);}if(type==='IDAT')data.push(chunk);at+=n+12;if(type==='IEND'){assert.equal(n,0);assert.equal(at,bytes.length);end=true;}}
 assert(header&&end);const raw=inflateSync(Buffer.concat(data)),rows=[];assert.equal(raw.length,height*(width*4+1));
 for(let row=0;row<height;row++){const at=row*(width*4+1);assert.equal(raw[at],0);rows.push(raw.subarray(at+1,at+1+width*4));}return Buffer.concat(rows);
}
async function directOwner(f,barrier){
 await f.server.close();const lease=await acquireRoot(f.root);let db;
 try{db=new StoreDatabase(f.root,barrier);}catch(error){lease.close();throw error;}let closed=false;
 return {db,async close(){if(closed)return;closed=true;await db.candidates.close();await db.queue.close();await db.portables.close();await db.histories.close();await db.rasters.close();await db.assets.close();await db.recovery.settle();db.close();lease.close();}};
}
async function editLoopback(t,{masked=false,references=false,holdUpload=false,foreignUpload=false,lostACK=false,incompleteUpload=false,fields={},barrier=()=>{}}={}){
 const cleanup=[],ports=[],effects=[],serverErrors=[],sockets=new Set();let owner,server,origin='',releaseUpload,resolveUpload,resolveRequestDrained;
 const uploadObserved=new Promise(resolve=>{resolveUpload=resolve;}),requestDrained=new Promise(resolve=>{resolveRequestDrained=resolve;});
 t.after(async()=>{for(const port of ports)await port.close();if(server){const closed=new Promise(resolve=>server.close(resolve));for(const socket of sockets)socket.destroy();await closed;}await owner?.close();for(const close of cleanup)await close();assert.deepEqual(serverErrors,[]);});
 const input=await fixture({name:t.name,after:close=>cleanup.push(close)},masked,references?'distinct':'none'),{f,draft}=input;
 Object.assign(draft.fields,{count:'1',seed:editSeed},fields);await save(f,draft);const reviewed=await review(f),accepted=await accept(f,reviewed),queued=await operate(f,queueBody(reviewed,accepted));
 const originalJob=(await queueView(f)).jobs.find(value=>value.id===queued.event.payload.id);assert(originalJob);assert.equal(originalJob.review.dispatch,false);assert.equal(originalJob.review.providerReview.admission.state,'blocked');
 const initialRefs=[draft.source.blob,draft.source.pixels,...(draft.mask?[draft.mask.blob,draft.mask.pixels,draft.mask.plan]:[])],originalBytes=await Promise.all(initialRefs.map(ref=>readFile(objectPath(f.root,ref)))),expected=await Promise.all(originalJob.stagePlan.map(stage=>readFile(objectPath(f.root,stage.transport))));
 owner=await directOwner(f,barrier);
 if(holdUpload){const release=owner.db.objects.release.bind(owner.db.objects);t.mock.method(owner.db.objects,'release',id=>{release(id);if(id.startsWith('queue-wire:')&&owner.db.objects.reservationInventory().activeTransfers===1)resolveRequestDrained();});}
 const job=()=>owner.db.queue.view().jobs.find(value=>value.id===originalJob.id),outbox=()=>owner.db.queue.recovery(originalJob.id,originalJob.attempts[0].id).outbox;
 const urls=Object.fromEntries(originalJob.stagePlan.map((stage,index)=>[stage.role,'/uploaded/role-'+index+'.png']));let uploads=0;
 server=createServer(async(req,res)=>{try{
  const fence=structuredClone(outbox()),bytes=Buffer.concat(await Array.fromAsync(req));effects.push({method:req.method,path:req.url,headers:{...req.headers},bytes,fence});
  if(req.url==='/protected.png'){assert.equal(req.method,'GET');assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined);res.setHeader('Content-Type','image/png');res.setHeader('Content-Length',String(protectedPNG.length));res.end(protectedPNG);return;}
  assert.equal(req.headers.authorization,'Key '+sentinel);assert.equal(req.headers['x-fal-store-io'],'0');res.setHeader('Content-Type','application/json');
  if(req.method==='POST'&&req.url==='/upload'){
   const index=uploads++,stage=originalJob.stagePlan[index];assert(stage);assert.equal(job().attempts[0].state,'not-started');assert.equal(job().attempts[0].count,'reserved');assert.equal(job().attempts[0].hold,true);assert.equal(fence.payloadHash,null);
   assert.deepEqual(bytes,expected[index]);assert.equal(digest(bytes),stage.transport.hash);assert.equal(req.headers['content-length'],stage.transport.byteLength);assert.equal(req.headers['transfer-encoding'],undefined);assert.equal(req.headers['content-type'],'application/octet-stream');
   const respond=()=>res.end(JSON.stringify({url:(foreignUpload?'http://127.0.0.1:1':origin)+urls[stage.role]}));if(holdUpload&&index===0){releaseUpload=respond;resolveUpload();return;}respond();return;
  }
  if(req.method==='POST'){
   assert.equal(req.url,'/ideogram/v4.5/edit');assert.equal(uploads,originalJob.stagePlan.length);assert.equal(fence.state,'dispatching');assert.equal(fence.epoch,owner.db.epoch);assert.equal(fence.payloadHash,digest(bytes));assert.equal(fence.wireEvidence.conflicted,false);assert.equal(fence.wireEvidence.uploads.length,uploads);
   assert.deepEqual(bytes,expectedEditWire(masked,Object.fromEntries(Object.entries(urls).map(([role,path])=>[role,origin+path])),draft.references));assert.equal(req.headers['x-fal-no-retry'],'1');
   if(lostACK){req.socket.destroy();return;}const base=origin+'/ideogram/v4.5/edit/requests/prepared_returned';res.end(JSON.stringify({request_id:'prepared_returned',status_url:base+'/status',response_url:base,cancel_url:base+'/cancel'}));return;
  }
  assert.equal(req.method,'GET');if(req.url==='/ideogram/v4.5/edit/requests/prepared_returned/status'){res.end('{"request_id":"prepared_returned","status":"COMPLETED"}');return;}
  assert.equal(req.url,'/ideogram/v4.5/edit/requests/prepared_returned');res.end('{"images":[{"url":'+JSON.stringify(origin+'/protected.png')+',"content_type":"image/png","file_size":'+protectedPNG.length+'}],"seed":'+editSeed+'}');
 }catch(error){if(incompleteUpload&&req.aborted&&req.method==='POST'&&req.url==='/upload'){effects.push({method:req.method,path:req.url,bytes:Buffer.alloc(0),aborted:true});res.destroy();return;}serverErrors.push(String(error?.stack??error));res.statusCode=500;res.end();}});
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
 const selection=()=>({jobId:originalJob.id,attemptId:originalJob.attempts[0].id,reviewToken:reviewed.token,origin}),port=()=>{const value=createV45LoopbackEdit(owner.db.queue,owner.db.candidates,selection());ports.push(value);return value;};
 return {...input,reviewed,job,outbox,selection,port,effects,expected,uploadObserved,requestDrained,releaseUpload:()=>{assert(releaseUpload);releaseUpload();},get db(){return owner.db;},
  async unchanged(){for(const [index,ref]of initialRefs.entries())assert.deepEqual(await readFile(objectPath(f.root,ref)),originalBytes[index]);assert.deepEqual(job().review,reviewed);},
  async command(type){const current=job(),command=envelope(f,{type,jobId:current.id,attemptId:current.attempts[0].id,expectedVersion:current.version}),auth={clientId:f.paired.json.clientId,sessionHash:'c'.repeat(64),now:Date.now(),expires:Date.now()+1800000};const receipt=await owner.db.queue.command(Buffer.from(JSON.stringify(command)),auth);assert.equal(receipt.status,'accepted',JSON.stringify(receipt));return receipt;},
  async reopen(){for(const value of ports)await value.close();await owner.close();owner=await directOwner(f,barrier);}};
}
function assertWireStages(x){
 const out=x.outbox();assert.equal(out.wireEvidence.conflicted,false);assert.equal(out.wireEvidence.uploads.length,x.job().stagePlan.length);assert(out.wireEvidence.submission);
 for(const [index,stage]of x.job().stagePlan.entries()){
  const upload=out.wireEvidence.uploads[index];assert.deepEqual(upload.stage,stage);assert.equal(upload.url,x.selection().origin+'/uploaded/role-'+index+'.png');assert.equal(upload.request.bodyHash,stage.transport.hash);
  for(const [direction,ref]of [['request',upload.request],['response',upload.response]]){const meta=x.db.queue.evidence.inspect(ref.recordId);assert.equal(meta.attemptId,x.job().attempts[0].id);assert.equal(meta.direction,direction);assert.equal(meta.completeness,'complete');assert.equal(meta.wireExecution.boundary,'loopback-fixture-1');assert.equal(meta.wireExecution.role,'upload');assert.equal(meta.wireExecution.pathname,'/upload');assert.equal(meta.policy.profileId,'v45-edit-durable-loopback-1');}
  assert.deepEqual(Buffer.concat([...x.db.queue.evidence.read(upload.request.recordId)]),x.expected[index]);
 }
 assert.equal(out.wireEvidence.submission.payloadHash,digest(x.effects.find(effect=>effect.path==='/ideogram/v4.5/edit').bytes));
}
for(const masked of [false,true])for(const references of [false,true])test('durable V45 '+(masked?'masked':'regular')+' prepared HTTP '+(references?'ordered repeated references':'single source')+' retains exact bytes and withheld output',async t=>{
 const x=await editLoopback(t,{masked,references}),port=x.port(),roles=['source',...(masked?['mask']:[]),...(references?Array.from({length:masked?3:4},(_,index)=>'reference:'+index):[])];
 assert.deepEqual(x.job().stagePlan.map(stage=>stage.role),roles);assert.equal(x.db.queue.reserve(x.job().id),null);let decoded=0;const prepare=x.db.rasters.prepareDocument.bind(x.db.rasters);t.mock.method(x.db.rasters,'prepareDocument',(...args)=>{decoded++;return prepare(...args);});
 const acknowledged=await port.submit();assert.equal(acknowledged.attempts[0].state,'acknowledged');assert.equal(acknowledged.attempts[0].requestId,'prepared_returned');assert.equal(acknowledged.attempts[0].providerAuthorization,undefined);assertWireStages(x);
 assert.equal(await port.submit(),null);assert.equal(x.effects.filter(effect=>effect.method==='POST').length,roles.length+1);
 if(masked){const bytes=x.effects.filter(effect=>effect.path==='/upload')[1].bytes;assert.deepEqual(tinyRGBA(bytes,3,2),Buffer.from([255,255,255,255,0,0,0,255,255,255,255,255,255,255,255,255,0,0,0,255,255,255,255,255]));}
 if(references){const refs=x.outbox().wireEvidence.uploads.filter(value=>value.stage.role.startsWith('reference:'));assert.equal(refs[0].request.bodyHash,refs[2].request.bodyHash);assert.notEqual(refs[0].request.bodyHash,refs[1].request.bodyHash);assert.notEqual(refs[0].url,refs[2].url);assert.equal(new Set(refs.map(value=>value.request.recordId)).size,refs.length);assert.equal(roles.length,5);}
 await port.tick();const view=x.db.candidates.view(x.job().id),candidate=view.items[0];assert.equal(view.observation.phase,'completed');assert.equal(view.actualCount,1);assert.equal(candidate.safety,'unknown');assert.equal(candidate.state,'withheld');assert(candidate.encodedAssetId);assert.equal(candidate.preparedAssetId,null);assert.equal(decoded,0);assert.equal(view.provenance.returnedSeed,editSeed);assert.equal(view.provenance.complete,false);
 const asset=x.db.assets.asset(candidate.encodedAssetId);assert.deepEqual(Buffer.from(x.db.objects.verify(asset.blob,true)),protectedPNG);assert.throws(()=>x.db.assets.safeAsset(asset.id),{code:'CONTENT_WITHHELD'});await assert.rejects(x.db.candidates.reviewAdoption(candidate.id,'full-candidate','forbidden_edit_adoption','no-slot',()=>{}),{code:'INCOMPATIBLE'});
 await x.unchanged();assert.equal(x.db.objects.reservationInventory().activeTransfers,0);assert.equal(x.db.objects.hasLeases(),false);assert.equal(x.db.queue.view().counts.dispatched,1);assert.equal(x.db.queue.view().counts.active,0);
});

for(const action of ['cancel','close'])test('durable V45 '+action+' during an actual prepared upload prevents queue POST',async t=>{
 const x=await editLoopback(t,{holdUpload:true}),port=x.port(),pending=port.submit();const rejected=action==='close'?assert.rejects(pending,{code:'STALE_EPOCH'}):null;
 await x.uploadObserved;await x.requestDrained;if(action==='cancel'){await x.command('CancelJob');x.releaseUpload();assert.equal(await pending,null);assert.equal(x.job().attempts[0].count,'released');assert.equal(x.job().attempts[0].hold,false);}else{await port.close();await rejected;assert.equal(x.job().attempts[0].state,'not-started');assert.equal(x.job().attempts[0].count,'reserved');await x.command('CancelJob');}
 assert.deepEqual(x.effects.map(effect=>effect.path),['/upload']);assert.equal(x.outbox().wireEvidence?.submission??null,null);assert.equal(x.db.queue.view().counts.dispatched,0);assert.equal(x.db.objects.reservationInventory().activeTransfers,0);assert.equal(x.db.objects.hasLeases(),false);await x.unchanged();
});

for(const damage of ['missing','corrupt'])test('durable V45 '+damage+' prepared mask refuses before its upload and edit POST',async t=>{
 const x=await editLoopback(t,{masked:true,incompleteUpload:true}),port=x.port(),stage=x.job().stagePlan[1],path=objectPath(x.f.root,stage.transport),saved=await readFile(path),moved=path+'.fixture-missing';
 try{
  if(damage==='missing')await rename(path,moved);else{const bad=Buffer.from(saved);bad[bad.length-1]^=1;await writeFile(path,bad);}
  await assert.rejects(port.submit());assert.deepEqual(x.effects.filter(effect=>effect.bytes.length).map(effect=>effect.path),['/upload']);assert.equal(x.effects.some(effect=>effect.path==='/ideogram/v4.5/edit'),false);assert.equal(x.outbox().wireEvidence.uploads.length,1);assert.equal(x.outbox().wireEvidence.uploads[0].stage.role,'source');assert.equal(x.job().attempts[0].state,'not-started');assert.equal(x.db.queue.view().counts.dispatched,0);assert.equal(x.db.objects.reservationInventory().activeTransfers,0);assert.equal(x.db.objects.hasLeases(),false);
 }finally{if(damage==='missing')await rename(moved,path);else await writeFile(path,saved);}
 await x.command('CancelJob');assert.equal(await port.submit(),null);await x.unchanged();
});

test('durable V45 foreign upload URL is refused before any follow-up upload or edit POST',async t=>{
 const x=await editLoopback(t,{masked:true,foreignUpload:true}),port=x.port();await assert.rejects(port.submit(),{code:'POLICY'});assert.deepEqual(x.effects.map(effect=>effect.path),['/upload']);assert.equal(x.outbox().wireEvidence?.uploads.length??0,0);assert.equal(x.db.queue.view().counts.dispatched,0);assert.equal(x.db.objects.reservationInventory().activeTransfers,0);await x.command('CancelJob');
});

test('durable V45 prepared lost ACK restarts the same uncertain attempt without repeating uploads or POST',async t=>{
 const x=await editLoopback(t,{lostACK:true}),old=x.port();await assert.rejects(old.submit());assert.equal(x.job().attempts[0].state,'submission-uncertain');assert.equal(x.job().attempts[0].requestId,null);assert.equal(x.job().attempts[0].count,'dispatched');const before=x.effects.length,uploads=structuredClone(x.outbox().wireEvidence.uploads);
 await x.reopen();await assert.rejects(old.submit(),{code:'STALE_EPOCH'});const port=x.port();await port.tick();await x.command('RecoverJob');await port.recoverRetained();await port.tick();assert.equal(await port.submit(),null);assert.equal(x.effects.length,before);assert.deepEqual(x.outbox().wireEvidence.uploads,uploads);assert.equal(x.job().attempts.length,1);assert.equal(x.job().attempts[0].requestId,null);assert.equal(x.job().attempts[0].hold,true);assert.match(x.job().attempts[0].controlWarning,/No validated acknowledgement/);await assert.rejects(port.readKnown('status'),{code:'STALE_EPOCH'});
});

test('durable V45 prepared ACK requires explicit same-attempt recovery after restart and preserves withheld output',async t=>{
 const x=await editLoopback(t,{masked:true}),old=x.port();await old.submit();const before=x.effects.length,wire=structuredClone(x.outbox().wireEvidence);await x.reopen();const port=x.port();await port.tick();assert.equal(x.effects.length,before);assert.equal(await port.submit(),null);await assert.rejects(port.readKnown('status'),{code:'STALE_EPOCH'});
 await x.command('RecoverJob');await port.tick();assert.equal(x.job().attempts.length,1);assert.equal(x.job().attempts[0].requestId,'prepared_returned');assert.equal(x.effects.filter(effect=>effect.method==='POST').length,3);assert.deepEqual(x.outbox().wireEvidence,wire);assert.equal(x.db.candidates.view(x.job().id).items[0].state,'withheld');await x.unchanged();
});

test('durable V45 prepared lease rechecks the actual final fence after all uploads',async t=>{
 let port;const x=await editLoopback(t,{barrier:phase=>{if(phase==='queue-before-dispatch-fence')void port.close();}});port=x.port();await assert.rejects(port.submit(),{code:'STALE_EPOCH'});assert.deepEqual(x.effects.map(effect=>effect.path),['/upload']);assert.equal(x.outbox().wireEvidence.uploads.length,1);assert.equal(x.db.queue.view().counts.dispatched,0);assert.equal(x.db.objects.reservationInventory().activeTransfers,0);await x.command('CancelJob');
});

test('durable V45 separate factories retain their exact admitted request shapes before effects',async t=>{
 const x=await editLoopback(t,{fields:{count:'2'}}),before=structuredClone(x.db.queue.view());assert.throws(()=>x.port(),{code:'IDENTITY'});assert.throws(()=>createV45LoopbackGeneration(x.db.queue,x.db.candidates,x.selection()),{code:'IDENTITY'});assert.deepEqual(x.db.queue.view(),before);assert.equal(x.effects.length,0);
 const single=await editLoopback(t);for(const change of [{origin:'https://queue.fal.run'},{origin:'http://localhost:12345'},{reviewToken:hash('other')},{uploadURL:single.selection().origin+'/upload'},{credential:()=>sentinel},{wire:()=>assert.fail('No injected transport')}])assert.throws(()=>createV45LoopbackEdit(single.db.queue,single.db.candidates,{...single.selection(),...change}));assert.equal(single.effects.length,0);
});

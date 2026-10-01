import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {rootFor,command,pair,call,cookieFrom,readHeaders,mutationHeaders} from '../protocol/helpers.mjs';
import {importRaster,operate,terminal} from '../raster/helpers.mjs';
import {upload} from '../portable/helpers.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {newDraft} from '../../dist/local/src/request/core.js';
import {canonical} from '../../dist/local/server/storage/canonical.js';
import {verificationBudget} from '../../dist/local/src/protocol/text-budget.js';

const documentId='document_1',sessionId='candidate_replacement';
const document=async f=>(await f.read('/api/v1/documents/'+documentId)).json.projection.value;
const image=async f=>(await f.read('/api/v1/documents/'+documentId+'/image')).json;
const objectPath=(f,ref)=>join(f.root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
async function retained(f,ref){const bytes=await readFile(objectPath(f,ref));assert.equal(sha(bytes),ref.hash);assert.equal(String(bytes.length),ref.byteLength);return bytes;}
async function pixels(f,id){return retained(f,(await f.read('/api/v1/assets/'+id)).json.projection.value.raster.pixels);}
async function events(f,receipt){
  const response=await f.read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n));assert.equal(response.status,200,response.text);
  const batch=response.json.batches[0];if(batch.kind==='inline')return batch.events;
  const content=await f.read(batch.content.url);assert.equal(content.status,200,content.text);assert.equal(sha(content.text),batch.content.blob.hash);
  return content.text.split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
async function run(f,body){
  const before=await document(f),request=f.command({documentId,expectedDocumentRevision:before.revision,body}),result=await terminal(f,request);
  assert.equal(result.json.receipt.status,'accepted',result.text);
  return {request,receipt:result.json.receipt,events:await events(f,result.json.receipt),document:await document(f)};
}
async function properties(f,id,value){const layer=(await image(f)).layers.find(layer=>layer.id===id);return run(f,{type:'SetLayerProperties',layerId:id,layerVersion:layer.version,properties:value,draft:null});}
async function stage(f,bytes,purpose='caption',mediaType='text/plain'){
  const staged=await upload(f,bytes,purpose,mediaType);
  return (await operate(f,{type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256})).event.payload.asset;
}
async function ui(f,body){
  const current=(await f.read('/api/v1/ui/'+sessionId)).json,request={protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:current.uiSeq,body};
  const result=await f.post('/api/v1/ui/'+sessionId,request);assert.equal(result.json.status,'accepted',result.text);return {request,value:result.json};
}
async function fixture(t){
  // Stop the real writer/emulator before rootFor removes its diagnostic target.
  let server;t.after(()=>server?.close());const root=await rootFor(t);
  server=await startLocalServer({root},{writer:{setupModule:new URL('../candidates/observer-fixture.mjs',import.meta.url).href}});
  const paired=await pair(server);assert.equal(paired.status,200,paired.text);
  const f={root,server,paired,
    read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))}),
    post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),
    command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body),
    effects:async()=>{const value=JSON.parse(await readFile(join(root,'candidate-fixture.json'),'utf8'));assert.deepEqual(value.errors,[]);return value.effects;},
  };
  assert.equal((await terminal(f,f.command({}, {width:16,height:16}))).json.receipt.status,'accepted');return f;
}
async function candidate(f){
  const prompt=await stage(f,Buffer.from('Replace the selected image without growing its stack')),draft=newDraft(prompt.blob);
  Object.assign(draft.fields,{width:'512',height:'512'});
  const saved=await stage(f,Buffer.from(JSON.stringify(draft)));
  await ui(f,{type:'SaveDraft',draft:{id:'request',generation:'1',kind:'request',documentId,targetLayerId:null,expectedDocumentRevision:(await document(f)).revision,assetId:saved.id,composing:false}});
  const review=(await ui(f,{type:'PrepareRequestReview',draftId:'request',generation:'1'})).value.review;
  const accepted=await ui(f,{type:'AcceptRequestReview',reviewId:review.id,token:review.token});
  const queued=await operate(f,{type:'QueueInference',reviewId:review.id,token:review.token,acceptanceId:accepted.request.requestId}),jobId=queued.event.payload.id;
  let value;const deadline=Date.now()+20000;
  do{const response=await f.read('/api/v1/jobs/'+jobId+'/candidates');if(response.status===200)value=response.json.items[0];if(value?.state==='prepared')break;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<deadline);
  assert.equal(value?.state,'prepared',JSON.stringify(value));return value;
}
const placement=(candidate,target,type='ReviewCandidatePlacement',patch={})=>({type,candidateId:candidate.id,mode:'full-candidate',placement:'current-document',newDocumentId:null,actualOutput:null,newLayerId:target.id,name:'Replacement image',replacement:{layerId:target.id,layerVersion:target.version},...patch});
async function reviewed(f,body){
  const before=await document(f),beforeImage=await image(f),prepared=await run(f,body);
  assert.deepEqual(await document(f),before);assert.deepEqual(await image(f),beforeImage);
  if(body.type==='ReviewCandidatePlacement'){
    assert.deepEqual(prepared.events.map(event=>event.type),['CandidatePlacementReviewPrepared']);
    const review=(await f.read('/api/v1/image-edit-reviews/'+prepared.events[0].payload.reviewId)).json;
    assert.deepEqual(review.placement.replacement,body.replacement);assert.deepEqual(review.source,before.image);
    return {body:{type:'AdoptReviewedCandidate',reviewId:review.reviewId,reviewHash:review.reviewHash,draft:null},review};
  }
  const preview=prepared.events.at(-1).payload.preview,reviewed=await run(f,{type:'ReviewImageEdit',previewId:preview.previewId});
  const review=(await f.read('/api/v1/image-edit-reviews/'+reviewed.events.at(-1).payload.reviewId)).json;
  assert.deepEqual(JSON.parse(await retained(f,preview.plan)).command.replacement,body.replacement);
  return {body:{type:'AdoptCandidate',previewId:preview.previewId,reviewId:review.reviewId,reviewHash:review.reviewHash,draft:null},review,preview};
}
async function rejected(f,body,code,reason){
  const before=await document(f),beforeImage=await image(f),request=f.command({documentId,expectedDocumentRevision:before.revision,body}),result=await terminal(f,request);
  assert.equal(result.json.receipt.status,'rejected',result.text);assert.equal(result.json.receipt.code,code,result.text);
  if(reason)assert.equal(JSON.parse(await retained(f,result.json.receipt.details)).issues[0].code,reason);
  assert.deepEqual(await document(f),before);assert.deepEqual(await image(f),beforeImage);return result.json.receipt;
}
async function malformed(f,body){
  const before=await document(f),beforeImage=await image(f),result=await f.post('/api/v1/commands',f.command({documentId,expectedDocumentRevision:before.revision,body}));
  assert.equal(result.status,400,result.text);assert.deepEqual(await document(f),before);assert.deepEqual(await image(f),beforeImage);
}
function replacementState(before,after,targetId){
  assert.equal(after.layers.length,before.layers.length);assert.deepEqual(after.layers.map(layer=>layer.id),before.layers.map(layer=>layer.id));
  const index=before.layers.findIndex(layer=>layer.id===targetId),old=before.layers[index],next=after.layers[index];
  assert.notEqual(next.assetId,old.assetId);
  assert.deepEqual(next,{...old,version:String(BigInt(old.version)+1n),name:'Replacement image',assetId:next.assetId,layerToDocument:[1,0,0,1,0,0],opacity:1,mask:null});
  for(let at=0;at<before.layers.length;at++)if(at!==index)assert.deepEqual(after.layers[at],before.layers[at]);
  return next;
}

test('both candidate placement paths replace the selected image at 100 layers with exact stroke Undo history',{timeout:180000},async t=>{
  const f=await fixture(t),c=await candidate(f),effects=await f.effects(),{input,asset}=await importRaster(f,'black.png'),filler=(await importRaster(f,'white.png')).asset;
  const originalBytes=await retained(f,input.blob),originalPixels=await retained(f,asset.raster.pixels),targetId='layer_049';
  // Build the capacity boundary using admitted public commands and a small
  // document grid. No synthetic image state or database seeding is involved.
  let revision=(await document(f)).revision;
  for(let index=0;index<100;index++){
    const id='layer_'+String(index).padStart(3,'0'),result=await terminal(f,f.command({documentId,expectedDocumentRevision:revision,body:{type:'ImportAsset',assetId:id===targetId?asset.id:filler.id,layerId:id,name:id,draft:null}}));
    assert.equal(result.json.receipt.status,'accepted',result.text);revision=result.json.receipt.documentRevision;
  }
  assert.equal((await image(f)).layers.length,100);
  await run(f,{type:'ApplyTransform',layerId:targetId,layerVersion:'1',transform:[16,0,0,16,0,0],draft:null});
  await properties(f,targetId,{opacity:0.5});
  await run(f,{type:'SetLayerAppearance',layerId:targetId,layerVersion:'3',description:'Retain this selected image description',draft:null});
  const unmasked=await image(f),unmaskedDocument=await document(f),unmaskedPixels=await pixels(f,unmaskedDocument.image.compositeAssetId);
  const mask=(await operate(f,{type:'PrepareMask',plan:{width:16,height:16,feather:0,operations:[{kind:'shape',shape:{kind:'rectangle',x:0,y:0,width:16,height:16},mode:'replace'},{kind:'stroke',points:[[4,8],[12,8]],size:4,hardness:1,mode:'subtract'}]}})).event.payload.asset;
  const stroked=await properties(f,targetId,{mask:{assetId:mask.id,mapping:'document-r16-v1',inverted:false}}),before=await image(f),beforePixels=await pixels(f,stroked.document.image.compositeAssetId),target=before.layers[49];
  assert.equal(target.id,targetId);assert.notDeepEqual(beforePixels,unmaskedPixels);
  const {replacement,...additive}=placement(c,target);await rejected(f,{...additive,newLayerId:'layer_101'},'CAPACITY','NEW_LAYER_UNAVAILABLE');
  const approved=await reviewed(f,placement(c,target)),committed=await run(f,approved.body),after=await image(f),next=replacementState(before,after,targetId);
  assert.equal(after.layers.length,100);assert.deepEqual(committed.document.orderedLayerIds,before.layers.map(layer=>layer.id));
  const history=committed.events.at(-1).payload.history;assert.equal(history.operation,'AdoptReviewedCandidate');assert.deepEqual(history.before,stroked.document.image);
  assert.deepEqual(JSON.parse(await retained(f,history.before.state)),before);
  assert.deepEqual((await pixels(f,next.assetId)).subarray(0,4),Buffer.from([36,104,172,255]));
  assert.deepEqual(await retained(f,input.blob),originalBytes);assert.deepEqual(await retained(f,asset.raster.pixels),originalPixels);
  assert.deepEqual((await f.read('/api/v1/assets/'+asset.id)).json.projection.value,asset);

  const undoReplacement=await run(f,{type:'Undo',historyHead:committed.document.historyHead});
  assert.deepEqual(await image(f),before);assert.deepEqual(await pixels(f,undoReplacement.document.image.compositeAssetId),beforePixels);
  const undoStroke=await run(f,{type:'Undo',historyHead:undoReplacement.document.historyHead});
  assert.deepEqual(await image(f),unmasked);assert.deepEqual(await pixels(f,undoStroke.document.image.compositeAssetId),unmaskedPixels);
  await run(f,{type:'Redo',historyNode:stroked.document.historyHead});assert.deepEqual(await image(f),before);
  await run(f,{type:'Redo',historyNode:committed.document.historyHead});assert.deepEqual(await image(f),after);

  await run(f,{type:'Undo',historyHead:committed.document.historyHead});
  const previewed=await reviewed(f,placement(c,target,'PrepareCandidateAdoption')),preparedCommit=await run(f,previewed.body),preparedAfter=await image(f);
  replacementState(before,preparedAfter,targetId);assert.equal(preparedAfter.layers.length,100);
  assert.equal(preparedCommit.events.at(-1).payload.history.operation,'AdoptCandidate');
  await run(f,{type:'Undo',historyHead:preparedCommit.document.historyHead});assert.deepEqual(await image(f),before);
  await run(f,{type:'Undo',historyHead:(await document(f)).historyHead});assert.deepEqual(await image(f),unmasked);
  assert.deepEqual(await retained(f,input.blob),originalBytes);assert.deepEqual(await retained(f,asset.raster.pixels),originalPixels);
  assert.deepEqual(await f.effects(),effects);
});

async function nativeLayout(request,fonts){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('../../dist/local/server/text/render-worker.mjs',import.meta.url),{workerData:{request,fonts},env:{},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}});
    let result,error;const timer=setTimeout(()=>{error=Error('Native replacement fixture render deadline');void worker.terminate();},20000);
    worker.on('message',message=>{if(message.type==='ready')worker.postMessage({type:'admit'});else if(message.type==='result')result=message;else error=Error(JSON.stringify(message));});
    worker.on('error',value=>{error=value;});worker.on('exit',code=>{clearTimeout(timer);if(error)reject(error);else if(code||!result)reject(Error('Native replacement fixture did not render'));else resolve(result);});
  });
}
async function addNativeText(f){
  const profileBytes=await readFile('src/text/profile.json'),profile=JSON.parse(profileBytes),fontProfile=profile.fonts.find(font=>font.id==='NotoSans');
  const source=await stage(f,await readFile('vendor/text/'+fontProfile.file),'font','application/octet-stream'),license=await stage(f,await readFile('vendor/text/'+fontProfile.licenseFile));
  const font=(await run(f,{type:'ImportFont',source:source.blob,license:license.blob,origin:'bundled',embeddingReviewed:true})).events[0].payload.asset.font;
  const current=await document(f),frame={width:16,height:16},style={primaryFont:font.bytes.hash,explicitFallbacks:[],sizePx:8,lineHeightMultiplier:1.2,fill:[40,90,190,0],align:'start',direction:'auto'},textValue='A';
  const token={documentId,documentRevision:current.revision,layerId:'native_text',layerVersion:'0',sessionId,generation:1};
  const rendered=await nativeLayout({text:textValue,style,frame,token},[{path:objectPath(f,font.bytes),length:Number(font.bytes.byteLength),hash:font.bytes.hash,origin:font.origin,licenseHash:font.licenseRecord.hash}]);
  const put=async bytes=>(await stage(f,bytes,'text','application/octet-stream')).blob,identify=value=>({...value,id:sha(canonical(value))});
  const textUtf8=(await stage(f,Buffer.from(textValue))).blob,layout={...await put(Buffer.from(rendered.layout)),mediaType:'application/json'},pixels={...await put(Buffer.alloc(frame.width*frame.height*4)),mediaType:'application/x-ideogram-rgba8'};
  assert.equal(rendered.rasterHash,pixels.hash);assert.equal(rendered.layoutHash,layout.hash);assert.equal(rendered.textHash,textUtf8.hash);
  const manifest={...await put(profileBytes),mediaType:'application/json'},text=identify({schemaVersion:1,textUtf8,style,frame,layoutPolicy:'text-layout-1',fonts:[font]});
  const dependencyHash=sha(JSON.stringify({rendererProfile:profile.id,textHash:textUtf8.hash,style,frame,fonts:[{hash:font.bytes.hash,licenseHash:font.licenseRecord.hash,faceIndex:0,format:font.format,parserProfile:font.parserProfile,fsType:font.fsType}]}));
  const render=identify({schemaVersion:1,textVersion:text.id,rendererProfile:{schemaVersion:1,id:profile.id,manifest},dependencyHash,layout,pixels,width:rendered.width,height:rendered.height,overflow:rendered.overflow,resolvedFonts:[font.id]});
  const candidate={...await put(Buffer.from(canonical({schemaVersion:1,token,source:{schemaVersion:1,text,render}}))),mediaType:'application/json'},draft=await stage(f,Buffer.from(canonical({schemaVersion:1,kind:'text-draft-1',textUtf8,style,frame,fonts:[font]})));
  await ui(f,{type:'SaveDraft',draft:{id:'native',generation:'1',kind:'text',documentId,targetLayerId:null,expectedDocumentRevision:current.revision,assetId:draft.id,composing:false}});
  const budget=verificationBudget(textValue,frame.width,frame.height,Number(font.bytes.byteLength),profile.engine.wasm.bytes),admissionId=randomUUID()+'_1_'+budget.bytes;
  assert.equal((await f.post('/api/v1/text-admission/'+admissionId,{protocolVersion:1})).status,200);
  const request=f.command({sessionId,documentId,expectedDocumentRevision:current.revision,body:{type:'CreateTextLayer',layerId:'native_text',name:'Native replacement target',candidate,draft:{sessionId,draftId:'native',generation:'1'},admissionId}}),result=await terminal(f,request);
  assert.equal(result.json.receipt.status,'accepted',result.text);assert.equal((await f.post('/api/v1/text-admission/'+admissionId+'/release',{protocolVersion:1})).status,200);
  const layer=(await image(f)).layers.find(layer=>layer.id==='native_text');assert.equal(layer.kind,'text');return layer;
}

test('candidate replacement refuses stale, missing, locked, hidden and text targets and rechecks both reviewed commits',{timeout:90000},async t=>{
  const f=await fixture(t),c=await candidate(f),effects=await f.effects(),{asset}=await importRaster(f,'white.png');
  await run(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Selected picture',draft:null});
  const text=await addNativeText(f),target=() => image(f).then(value=>value.layers.find(layer=>layer.id==='picture'));
  for(const type of ['ReviewCandidatePlacement','PrepareCandidateAdoption']){
    const current=await target();
    await rejected(f,placement(c,{...current,version:'999'},type),'STALE_REVISION','LAYER_VERSION_CHANGED');
    await rejected(f,placement(c,{id:'missing_layer',version:'1'},type),'STALE_REVISION','LAYER_VERSION_CHANGED');
    await rejected(f,placement(c,text,type),'INCOMPATIBLE','NEW_DOCUMENT_REQUIRED');
    await malformed(f,placement(c,current,type,{mode:'safe-region'}));
    await malformed(f,placement(c,current,type,{placement:'new-document',newDocumentId:'another_document'}));
    await malformed(f,placement(c,current,type,{newLayerId:'different_identity'}));
    await properties(f,'picture',{locked:true});
    await rejected(f,placement(c,await target(),type),'INCOMPATIBLE','NEW_DOCUMENT_REQUIRED');
    await properties(f,'picture',{locked:false});
    await properties(f,'picture',{visible:false});
    await rejected(f,placement(c,await target(),type),'INCOMPATIBLE','NEW_DOCUMENT_REQUIRED');
    await properties(f,'picture',{visible:true});
    const reviewedTarget=await target(),approved=await reviewed(f,placement(c,reviewedTarget,type));
    await properties(f,'picture',{name:'Changed after review '+type});
    assert.notEqual((await target()).version,reviewedTarget.version);
    await rejected(f,approved.body,'STALE_REVISION');
  }
  assert.equal((await image(f)).layers.length,2);assert.deepEqual((await image(f)).layers.find(layer=>layer.id==='native_text'),text);
  assert.deepEqual(await f.effects(),effects);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {terminalWithDiagnostics} from './native-failure-diagnostics.mjs';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {rootFor,command,pair,call,cookieFrom,readHeaders,mutationHeaders} from '../protocol/helpers.mjs';
import {importRaster,operate,terminal} from '../raster/helpers.mjs';
import {upload} from '../portable/helpers.mjs';
import {providerChild} from './candidate-copy-process-helpers.mjs';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {newDraft,bindRequestMask,confirmRequestMask,requestMaskDependencies} from '../../dist/local/src/request/core.js';
import {createRequestRasterPlan} from '../../dist/local/src/request/raster-plan.js';
import {canonical} from '../../dist/local/server/storage/canonical.js';
import {verificationBudget} from '../../dist/local/src/protocol/text-budget.js';
import {emptyComposition} from '../../dist/local/src/composition/core.js';
import {planTextTreatment,bindTextTreatmentEnvelope} from '../../dist/local/src/request/text-treatment.js';
import {candidatePlacementReview} from '../../dist/local/src/protocol/candidate-placement-review.js';

// Actual HTTP, queue, native verification worker, CP1 captures, mask preparation,
// previews and history writer. Only the provider boundary is the existing local
// observer fixture. Native glyphs deliberately have alpha zero, as in the native
// replacement fixture: identity/state and variant composition inputs are checked
// here; these tests do not claim visual glyph rendering qualification.
const documentId='document_1',sessionId='text_treatment_adoption';
const document=async(f,id=documentId)=>(await f.read('/api/v1/documents/'+id)).json.projection.value;
const image=async(f,id=documentId)=>(await f.read('/api/v1/documents/'+id+'/image')).json;
const objectPath=(f,ref)=>join(f.root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
async function retained(f,ref){const bytes=await readFile(objectPath(f,ref));assert.equal(sha(bytes),ref.hash);assert.equal(String(bytes.length),ref.byteLength);return bytes;}
async function asset(f,id){const response=await f.read('/api/v1/assets/'+id);assert.equal(response.status,200,response.text);return response.json.projection.value;}
async function pixels(f,id){return retained(f,(await asset(f,id)).raster.pixels);}
async function events(f,receipt){
 const response=await f.read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n));assert.equal(response.status,200,response.text);
 const batch=response.json.batches[0];if(batch.kind==='inline')return batch.events;
 const content=await f.read(batch.content.url);assert.equal(content.status,200,content.text);assert.equal(sha(content.text),batch.content.blob.hash);
 return content.text.split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
async function run(f,body){
 const before=await document(f),request=f.command({documentId,expectedDocumentRevision:before.revision,body}),result=await terminal(f,request);
 assert.equal(result.json.receipt.status,'accepted',result.text);return {request,receipt:result.json.receipt,events:await events(f,result.json.receipt),document:await document(f)};
}
async function properties(f,id,value){const l=(await image(f)).layers.find(l=>l.id===id);return run(f,{type:'SetLayerProperties',layerId:id,layerVersion:l.version,properties:value,draft:null});}
async function stage(f,bytes,purpose='caption',mediaType='text/plain'){
 const staged=await upload(f,bytes,purpose,mediaType);return (await operate(f,{type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256})).event.payload.asset;
}
async function ui(f,body){
 const current=(await f.read('/api/v1/ui/'+sessionId)).json,request={protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:current.uiSeq,body};
 const result=await f.post('/api/v1/ui/'+sessionId,request);assert.equal(result.json.status,'accepted',result.text);return {request,value:result.json};
}
async function fixture(t,{actualSize=512}={}){
 let close;t.after(()=>close?.());const root=await rootFor(t);
 if(actualSize!==512){assert.equal(actualSize,256);await writeFile(join(root,'text-treatment-result-size'),String(actualSize),{flag:'wx',mode:0o600});}
 const server=await providerChild(root,owned=>{close=owned;},new URL('./text-treatment-process-fixture.mjs',import.meta.url));
 const paired=await pair(server);assert.equal(paired.status,200,paired.text);
 const f={root,server,paired,read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))}),post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body),effects:async()=>{const value=JSON.parse(await readFile(join(root,'request-edits-fixture.json'),'utf8'));assert.deepEqual(value.errors,[]);return value.effects;}};
 assert.equal((await terminal(f,f.command({},{width:512,height:512}))).json.receipt.status,'accepted');
 const background=(await importRaster(f,'black.png')).asset;
 await run(f,{type:'ImportAsset',assetId:background.id,layerId:'background',name:'Original background',draft:null});
 await run(f,{type:'ApplyTransform',layerId:'background',layerVersion:'1',transform:[512,0,0,512,0,0],draft:null});
 await addNativeText(f);
 await run(f,{type:'ApplyTransform',layerId:'native_text',layerVersion:'1',transform:[1,0,0,1,8,12],draft:null});
 const mask=(await operate(f,{type:'PrepareMask',plan:{width:512,height:512,feather:0,operations:[{kind:'shape',shape:{kind:'rectangle',x:4,y:4,width:64,height:32},mode:'replace'}]}})).event.payload.asset;
 await properties(f,'native_text',{opacity:0.625,mask:{assetId:mask.id,mapping:'document-r16-v1',inverted:false}});
 const native=(await image(f)).layers.find(l=>l.id==='native_text');
 await run(f,{type:'SetLayerAppearance',layerId:native.id,layerVersion:native.version,description:'Authored local font, frame and document mask',draft:null});
 const hidden=(await importRaster(f,'white.png')).asset;
 await run(f,{type:'ImportAsset',assetId:hidden.id,layerId:'hidden_picture',name:'Hidden locked reference',draft:null});
 await properties(f,'hidden_picture',{visible:false,locked:true,opacity:0.375});
 return f;
}

async function nativeLayout(request,fonts){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('../../dist/local/server/text/render-worker.mjs',import.meta.url),{workerData:{request,fonts},env:{},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}});
    let result,error;const timer=setTimeout(()=>{error=Error('Native treatment fixture render deadline');void worker.terminate();},20000);
    worker.on('message',message=>{if(message.type==='ready')worker.postMessage({type:'admit'});else if(message.type==='result')result=message;else error=Error(JSON.stringify(message));});
    worker.on('error',value=>{error=value;});worker.on('exit',code=>{clearTimeout(timer);if(error)reject(error);else if(code||!result)reject(Error('Native treatment fixture did not render'));else resolve(result);});
  });
}
async function addNativeText(f,{textValue='A',layerVersion='0'}={}){
  const profileBytes=await readFile('src/text/profile.json'),profile=JSON.parse(profileBytes),fontProfile=profile.fonts.find(font=>font.id==='NotoSans');
  const source=await stage(f,await readFile('vendor/text/'+fontProfile.file),'font','application/octet-stream'),license=await stage(f,await readFile('vendor/text/'+fontProfile.licenseFile));
  const font=(await run(f,{type:'ImportFont',source:source.blob,license:license.blob,origin:'bundled',embeddingReviewed:true})).events[0].payload.asset.font;
  const current=await document(f),frame={width:16,height:16},style={primaryFont:font.bytes.hash,explicitFallbacks:[],sizePx:8,lineHeightMultiplier:1.2,fill:[40,90,190,0],align:'start',direction:'auto'},draftId=layerVersion==='0'?'native':'native_edit_'+randomUUID();
  const token={documentId,documentRevision:current.revision,layerId:'native_text',layerVersion,sessionId,generation:1};
  const rendered=await nativeLayout({text:textValue,style,frame,token},[{path:objectPath(f,font.bytes),length:Number(font.bytes.byteLength),hash:font.bytes.hash,origin:font.origin,licenseHash:font.licenseRecord.hash}]);
  const put=async bytes=>(await stage(f,bytes,'text','application/octet-stream')).blob,identify=value=>({...value,id:sha(canonical(value))});
  const textUtf8=(await stage(f,Buffer.from(textValue))).blob,layout={...await put(Buffer.from(rendered.layout)),mediaType:'application/json'},pixels={...await put(Buffer.alloc(frame.width*frame.height*4)),mediaType:'application/x-ideogram-rgba8'};
  assert.equal(rendered.rasterHash,pixels.hash);assert.equal(rendered.layoutHash,layout.hash);assert.equal(rendered.textHash,textUtf8.hash);
  const manifest={...await put(profileBytes),mediaType:'application/json'},text=identify({schemaVersion:1,textUtf8,style,frame,layoutPolicy:'text-layout-1',fonts:[font]});
  const dependencyHash=sha(JSON.stringify({rendererProfile:profile.id,textHash:textUtf8.hash,style,frame,fonts:[{hash:font.bytes.hash,licenseHash:font.licenseRecord.hash,faceIndex:0,format:font.format,parserProfile:font.parserProfile,fsType:font.fsType}]}));
  const render=identify({schemaVersion:1,textVersion:text.id,rendererProfile:{schemaVersion:1,id:profile.id,manifest},dependencyHash,layout,pixels,width:rendered.width,height:rendered.height,overflow:rendered.overflow,resolvedFonts:[font.id]});
  const candidate={...await put(Buffer.from(canonical({schemaVersion:1,token,source:{schemaVersion:1,text,render}}))),mediaType:'application/json'},draft=await stage(f,Buffer.from(canonical({schemaVersion:1,kind:'text-draft-1',textUtf8,style,frame,fonts:[font]})));
  await ui(f,{type:'SaveDraft',draft:{id:draftId,generation:'1',kind:'text',documentId,targetLayerId:layerVersion==='0'?null:'native_text',expectedDocumentRevision:current.revision,assetId:draft.id,composing:false}});
  const budget=verificationBudget(textValue,frame.width,frame.height,Number(font.bytes.byteLength),profile.engine.wasm.bytes),admissionId=randomUUID()+'_1_'+budget.bytes;
  assert.equal((await f.post('/api/v1/text-admission/'+admissionId,{protocolVersion:1})).status,200);
  try{
   const common={layerId:'native_text',candidate,draft:{sessionId,draftId,generation:'1'},admissionId},body=layerVersion==='0'?{type:'CreateTextLayer',...common,name:'Authored native lettering'}:{type:'CommitTextEdit',...common,layerVersion,reviewedDependencyHash:dependencyHash};
   const request=f.command({sessionId,documentId,expectedDocumentRevision:current.revision,body}),result=await terminalWithDiagnostics(f,request,{documentId,documentRevision:current.revision,layerId:'native_text',generation:'1',admissionId,admissionBudgetBytes:budget.bytes,rendererProfile:profile.id,frame});
   assert.equal(result.json.receipt.status,'accepted',result.text);
  }finally{assert.equal((await f.post('/api/v1/text-admission/'+admissionId+'/release',{protocolVersion:1})).status,200);}
  const layer=(await image(f)).layers.find(layer=>layer.id==='native_text');assert.equal(layer.kind,'text');return layer;
}


async function capture(f,scope,layerIds=[]){
 const before=await document(f),result=await run(f,{type:'PrepareRequestSource',scope,layerIds}),captured=result.events[0].payload.asset;
 assert.deepEqual(await document(f),before);assert.equal(result.events.length,1);
 const manifest=(await f.read('/api/v1/assets/'+captured.id+'/raster')).json;
 assert.deepEqual(manifest.plan.capture.image,before.image);
 return {asset:captured,manifest,source:{assetId:captured.id,version:captured.version,blob:captured.blob,pixels:captured.raster.pixels,width:512,height:512,scope,documentRevision:before.revision,capture:captured.raster.manifest}};
}
async function candidate(f,{kind='native-overlay',placement='current-document',mapped=false,cropSize=384,maskRect={x:128,y:128,width:8,height:8}}={}){
 const before=await document(f),beforeState=await image(f),nativeIds=beforeState.layers.filter(l=>l.kind==='text'&&l.visible).map(l=>l.id),baseline=await capture(f,'visible-document');
 const selected=kind==='native-overlay'?await capture(f,'single-layer',['background']):baseline,source=selected.source;
 const maskAsset=(await operate(f,{type:'PrepareRequestMask',sourceAssetId:source.assetId,plan:{width:512,height:512,feather:0,operations:[{kind:'shape',shape:{kind:'rectangle',...maskRect},mode:'replace'}]},clip:null})).event.payload.asset;
 const manifest=(await f.read('/api/v1/assets/'+maskAsset.id+'/raster')).json;
 const mask={assetId:maskAsset.id,version:maskAsset.version,blob:maskAsset.blob,pixels:maskAsset.raster.pixels,width:512,height:512,sourceHash:source.pixels.hash,polarity:'white-edit',fullAcknowledged:false,empty:false,full:false,plan:maskAsset.raster.manifest,binding:bindRequestMask(source)};
 mask.requestPlan=confirmRequestMask(source,mask,manifest.plan.hard,manifest.plan.effective,randomUUID());
 if(mapped)mask.requestPlan=createRequestRasterPlan({document:{width:512,height:512},crop:{x:0,y:0,width:cropSize,height:cropSize},padding:{left:0,top:0,right:0,bottom:0},requestGrid:{width:512,height:512},sourcePixels:source.pixels,authoredMask:manifest.plan.hard,effectiveMask:manifest.plan.effective,dependenciesHash:requestMaskDependencies(source,mask),resolution:'already-contained',approvalId:randomUUID()});
 const prompt=await stage(f,Buffer.from('Change the selected background and preserve explicitly reviewed native lettering')),draft=newDraft(prompt.blob);
 draft.operation='inpaint';Object.assign(draft.fields,{size:mapped?'custom':'auto',width:'512',height:'512',strength:'1'});draft.source=source;draft.mask=mask;
 const saved=await stage(f,Buffer.from(JSON.stringify(draft))),choice=kind==='native-overlay'?{kind,retainedNativeIds:nativeIds,placement,excludedSemanticIds:[],approvalId:randomUUID()}:{kind,allowedHideNativeIds:nativeIds,duplicationAcknowledgement:randomUUID(),excludedSemanticIds:[],approvalId:randomUUID()};
 await ui(f,{type:'SaveDraft',draft:{id:'request',generation:'1',kind:'request',documentId,targetLayerId:null,expectedDocumentRevision:before.revision,assetId:saved.id,composing:false}});
 const review=(await ui(f,{type:'PrepareRequestReview',draftId:'request',generation:'1',textTreatment:{kind:'text-treatment-review-intent-1',choice,baseline:baseline.source,beforeSource:baseline.source}})).value.review;
 assert.equal(review.kind,'request-review-text-1');const plan=JSON.parse(await retained(f,review.textTreatment.plan));
 assert.deepEqual(plan.inventory.imageState,before.image.state);assert.deepEqual(plan.beforeSource.source,baseline.source);assert.deepEqual(plan.afterSource.source,source);
 const accepted=await ui(f,{type:'AcceptRequestReview',reviewId:review.id,token:review.token}),queued=await operate(f,{type:'QueueInference',reviewId:review.id,token:review.token,acceptanceId:accepted.request.requestId}),jobId=queued.event.payload.id;
 let value;const deadline=Date.now()+20000;
 do{const response=await f.read('/api/v1/jobs/'+jobId+'/candidates');if(response.status===200)value=response.json.items[0];if(value?.state==='prepared')break;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<deadline);
 assert.equal(value?.state,'prepared',JSON.stringify(value));assert.deepEqual(await document(f),before);
 return {value,draft,review,plan,baseline,selected,before,beforeState,saved,nativeIds};
}
function placement(c,choicePatch={},bodyPatch={}){
 const choice={kind:'text-treatment-adoption-choice-1',action:'keep-native-overlay',approvalId:randomUUID(),duplicationAcknowledgement:null,newLayerId:'generated',hideNativeIds:[],nativeCopies:[],preservation:'single-original-contribution',...choicePatch};
 return {type:'PrepareCandidateAdoption',candidateId:c.value.id,mode:'safe-region',placement:'current-document',newDocumentId:null,actualOutput:null,newLayerId:choice.newLayerId,name:'Reviewed generated pixels',textTreatment:{kind:'candidate-text-treatment-1',plan:c.review.textTreatment,choice},...bodyPatch};
}
async function reviewed(f,body){
 const before=await document(f),beforeState=await image(f),prepared=await run(f,body),preview=prepared.events.at(-1).payload.preview;
 assert.deepEqual(await document(f),before);assert.deepEqual(await image(f),beforeState);
 assert.deepEqual(preview.candidate.textTreatment.plan,body.textTreatment.plan);assert.deepEqual(preview.candidate.textTreatment.choice,body.textTreatment.choice);
 const plan=JSON.parse(await retained(f,preview.plan));assert.deepEqual(plan.command,body);assert.deepEqual(plan.textTreatment,preview.candidate.textTreatment);
 const reviewed=await run(f,{type:'ReviewImageEdit',previewId:preview.previewId}),review=(await f.read('/api/v1/image-edit-reviews/'+reviewed.events.at(-1).payload.reviewId)).json;
 assert.deepEqual(review.preview,preview);return {preview,review,body:{type:'AdoptCandidate',previewId:preview.previewId,reviewId:review.reviewId,reviewHash:review.reviewHash,draft:null}};
}
async function reject(f,body,{code,reason,target=null}={}){
 const before=await document(f),beforeState=await image(f),request=f.command({documentId:target??documentId,expectedDocumentRevision:target?null:before.revision,body}),result=await terminal(f,request);
 assert.equal(result.json.receipt.status,'rejected',result.text);if(code)assert.equal(result.json.receipt.code,code,result.text);
 if(reason)assert.equal(JSON.parse(await retained(f,result.json.receipt.details)).issues[0].code,reason);
 assert.deepEqual(await document(f),before);assert.deepEqual(await image(f),beforeState);if(target)assert.equal((await f.read('/api/v1/documents/'+target)).status,404);
 return result.json.receipt;
}
async function malformed(f,body){
 const before=await document(f),beforeState=await image(f),response=await f.post('/api/v1/commands',f.command({documentId,expectedDocumentRevision:before.revision,body}));
 assert.equal(response.status,400,response.text);assert.deepEqual(await document(f),before);assert.deepEqual(await image(f),beforeState);
}
async function variants(f,preview,off,on){
 const value=preview.candidate.textTreatment;assert.equal(value.kind,'candidate-text-treatment-preview-1');
 for(const [id,layers]of [[value.nativeOffAssetId,off],[value.nativeOnAssetId,on]]){
  const manifest=(await f.read('/api/v1/assets/'+id+'/raster')).json;
  assert.equal(manifest.plan.kind,'cp1-composition');assert.deepEqual(manifest.plan.layers,layers.filter(l=>l.visible).map(l=>({assetId:l.assetId,transform:l.layerToDocument,opacity:l.opacity,mask:l.mask})));
  assert.equal((await pixels(f,id)).length,512*512*4);
 }
}
async function nativeIdentity(f,layer){
 const native=JSON.parse(await retained(f,layer.source)),raster=await asset(f,layer.assetId),mask=await asset(f,layer.mask.assetId),refs=[layer.source,native.text.textUtf8,native.render.layout,native.render.pixels,raster.raster.manifest,mask.raster.manifest,mask.raster.pixels,...native.text.fonts.flatMap(font=>[font.bytes,font.licenseRecord])];
 return {native,raster,mask,refs,bytes:await Promise.all(refs.map(ref=>retained(f,ref)))};
}
async function unchangedNative(f,layer,identity){
 assert.deepEqual(await asset(f,layer.assetId),identity.raster);assert.deepEqual(await asset(f,layer.mask.assetId),identity.mask);
 for(let at=0;at<identity.refs.length;at++)assert.deepEqual(await retained(f,identity.refs[at]),identity.bytes[at]);
}

async function preservedCandidate(f,wrapper){
 const retainedManifest=JSON.parse(await retained(f,wrapper.raster.manifest));assert.equal(retainedManifest.plan.kind,'retained-candidate-v1');assert.deepEqual(Object.keys(retainedManifest.plan).sort(),['kind','lineage','source']);assert.deepEqual(retainedManifest.dependencies,[retainedManifest.plan.source,retainedManifest.plan.lineage]);
 assert.equal(wrapper.raster.sourceAssetIds.length,1);const source=await asset(f,wrapper.raster.sourceAssetIds[0]);assert.equal(source.qualification,'canonical-raster');assert.deepEqual(source.raster.manifest,retainedManifest.plan.source);assert.deepEqual(wrapper.blob,source.blob);assert.deepEqual(wrapper.raster.pixels,source.raster.pixels);assert.equal(wrapper.raster.pixelIdentity,source.raster.pixelIdentity);
 const manifest=JSON.parse(await retained(f,retainedManifest.plan.source)),lineage=JSON.parse(await retained(f,retainedManifest.plan.lineage));assert.equal(manifest.plan.kind,'request-preservation-v1');assert.equal(lineage.kind,'adopted-candidate-lineage-1');assert.equal(lineage.inert,true);assert.deepEqual(manifest.pixels,wrapper.raster.pixels);
 for(const key of ['width','height','pipeline']){assert.equal(retainedManifest[key],wrapper.raster[key]);assert.equal(manifest[key],wrapper.raster[key]);assert.equal(source.raster[key],wrapper.raster[key]);}
 return {manifest,lineage};
}

function successorWitness(c,choice,identity,mapping,witness){
 assert.equal(mapping.resolution,'clipped-and-approved');
 assert.deepEqual(witness,{kind:'text-treatment-mask-successor-1',acceptedTreatmentPlan:c.review.textTreatment.plan,originalRequestPlan:c.plan.edit.requestPlan,originalEffectiveMask:c.draft.mask.requestPlan.effectiveMask,finalEffectiveMask:mapping.effectiveMask,candidateIdentityHash:sha(canonical(identity)),outputMappingHash:sha(canonical(mapping)),adoptionChoiceHash:sha(canonical(choice))});
}
async function clippedBoundary(f,c,mapping,coverage){
 assert.deepEqual(mapping.outputToDocument,[2,0,0,2,0,0]);assert.deepEqual(mapping.actualOutput,{width:256,height:256});assert.deepEqual(mapping.requestPlan,c.draft.mask.requestPlan);
 assert.deepEqual(coverage,{originalEffectivePixels:64,effectivePixels:56,lostPixels:8});assert.notEqual(mapping.effectiveMask.hash,c.draft.mask.requestPlan.effectiveMask.hash);
 const original=await retained(f,c.draft.mask.requestPlan.effectiveMask),final=await retained(f,mapping.effectiveMask);
 // Independent exact raster oracle: the original leftmost column is now
 // outside reconstruction support. Every other authored cell is unchanged.
 for(let y=0;y<512;y++)for(let x=0;x<512;x++){const offset=(y*512+x)*2,edited=x<8&&y>=128&&y<136;assert.equal(original.readUInt16LE(offset),edited?65535:0);assert.equal(final.readUInt16LE(offset),edited&&x>0?65535:0);}
 return {original,final};
}

function exterior(actual,original,mask){
 let equal=0,changed=0;
 for(let at=0;at<mask.length;at+=2){const offset=at*2;if(mask.readUInt16LE(at)===0){assert(actual.subarray(offset,offset+4).equals(original.subarray(offset,offset+4)),'exterior pixel '+at/2);equal++;}else if(!actual.subarray(offset,offset+4).equals(original.subarray(offset,offset+4)))changed++;}
 assert(equal>250000);assert(changed>0,'candidate actually changes edited pixels');
}

test('J17 single-K adoption preserves native render, source, frame, font, transform and mask identities through atomic history',{timeout:180000},async t=>{
 const f=await fixture(t),c=await candidate(f),native=c.beforeState.layers.find(l=>l.kind==='text'),identity=await nativeIdentity(f,native),original=await pixels(f,c.before.image.compositeAssetId),effects=await f.effects();
 assert.deepEqual(c.plan.rasterExcludedNativeIds,['native_text']);assert.deepEqual(c.plan.sourceSubset.includedLayerIds,['background']);
 const approved=await reviewed(f,placement(c)),previewState=JSON.parse(await retained(f,approved.preview.after.state));
 assert.deepEqual(previewState.layers.map(l=>[l.id,l.visible]),[['background',false],['generated',true],['native_text',true],['hidden_picture',false]]);
 assert.deepEqual(previewState.layers[0],{...c.beforeState.layers[0],version:String(BigInt(c.beforeState.layers[0].version)+1n),visible:false});
 assert.deepEqual(previewState.layers[2],native);assert.deepEqual(previewState.layers[3],c.beforeState.layers[2]);
 await variants(f,approved.preview,previewState.layers.map(l=>l.kind==='text'?{...l,visible:false}:l),previewState.layers);
 const applied=await run(f,approved.body);assert.deepEqual(applied.events.map(e=>e.type),['ImageEdited']);assert.deepEqual(await image(f),previewState);
 assert.equal(applied.events[0].payload.history.operation,'AdoptCandidate');assert.deepEqual(applied.events[0].payload.history.before,c.before.image);
 exterior(await pixels(f,applied.document.image.compositeAssetId),original,await retained(f,c.draft.mask.requestPlan.effectiveMask));await unchangedNative(f,native,identity);
 const undo=await run(f,{type:'Undo',historyHead:applied.document.historyHead});assert.deepEqual(await image(f),c.beforeState);assert.deepEqual(await pixels(f,undo.document.image.compositeAssetId),original);
 await run(f,{type:'Redo',historyNode:applied.document.historyHead});assert.deepEqual(await image(f),previewState);await unchangedNative(f,native,identity);
 assert.deepEqual(await f.effects(),effects);
});

test('J17 baked lettering hides only explicitly reviewed originals with one undoable edit and preserves all native bytes',{timeout:180000},async t=>{
 const f=await fixture(t),c=await candidate(f,{kind:'baked-lettering'}),native=c.beforeState.layers.find(l=>l.kind==='text'),identity=await nativeIdentity(f,native),effects=await f.effects();
 assert.deepEqual(c.plan.rasterIncludedNativeIds,['native_text']);assert.deepEqual(c.plan.allowedHideNativeIds,['native_text']);assert.deepEqual(c.plan.beforeSource,c.plan.afterSource);
 const body=placement(c,{action:'hide-native-originals',duplicationAcknowledgement:c.plan.choice.duplicationAcknowledgement,hideNativeIds:['native_text'],preservation:'none'},{mode:'full-candidate'}),approved=await reviewed(f,body),after=JSON.parse(await retained(f,approved.preview.after.state));
 assert.deepEqual(after.layers.map(l=>[l.id,l.visible]),[['background',true],['native_text',false],['hidden_picture',false],['generated',true]]);
 assert.deepEqual(after.layers[0],c.beforeState.layers[0]);assert.deepEqual(after.layers[2],c.beforeState.layers[2]);assert.deepEqual(after.layers[1],{...native,version:String(BigInt(native.version)+1n),visible:false});
 await variants(f,approved.preview,after.layers,after.layers.map(l=>l.id===native.id?{...l,visible:true}:l));
 assert.deepEqual(await image(f),c.beforeState,'preview never changes visibility');const applied=await run(f,approved.body);assert.deepEqual(applied.events.map(e=>e.type),['ImageEdited']);assert.deepEqual(await image(f),after);await unchangedNative(f,native,identity);
 await run(f,{type:'Undo',historyHead:applied.document.historyHead});assert.deepEqual(await image(f),c.beforeState);
 await run(f,{type:'Redo',historyNode:applied.document.historyHead});assert.deepEqual(await image(f),after);await unchangedNative(f,native,identity);assert.deepEqual(await f.effects(),effects);
});

test('J17 new-document adoption copies only selected native versions into fresh identities and leaves source Composition untouched',{timeout:180000},async t=>{
 const f=await fixture(t),native=(await image(f)).layers.find(l=>l.kind==='text');
 await run(f,{type:'DuplicateLayer',layerId:native.id,layerVersion:native.version,newLayerId:'unselected_native',name:'Unselected second native',draft:null});
 await properties(f,'unselected_native',{opacity:0.25});
 const composition=emptyComposition(512,512,randomUUID());composition.scene='Source document semantics stay in their original namespace';
 const value=await stage(f,Buffer.from(canonical(composition)),'text','application/octet-stream');
 await run(f,{type:'CommitCompositionVersion',composition:{id:composition.id,value:{...value.blob,mediaType:'application/json'},bindings:{}},draft:null});
 const c=await candidate(f,{placement:'new-document'}),target='new_text_document',sourceNative=c.beforeState.layers.find(l=>l.id===native.id),identity=await nativeIdentity(f,sourceNative),effects=await f.effects();
 assert.equal(c.beforeState.schemaVersion,5);assert(c.beforeState.composition);
 const copy={sourceLayerId:native.id,newLayerId:'copied_native',transform:[1,0,0,1,32,48]},body=placement(c,{action:'new-document',preservation:'none',nativeCopies:[copy]},{placement:'new-document',newDocumentId:target});
 await reject(f,{...body,textTreatment:{...body.textTreatment,choice:{...body.textTreatment.choice,nativeCopies:[{...copy,newLayerId:native.id}]}}},{code:'INVALID_INPUT',reason:'TEXT_TREATMENT_FRESH_LAYER_IDS_REQUIRED'});
 const approved=await reviewed(f,body);
 const after=JSON.parse(await retained(f,approved.preview.after.state));assert.equal(after.schemaVersion,5);assert.equal(after.composition,null);assert.deepEqual(after.layers.map(l=>l.id),['generated','copied_native']);
 assert.deepEqual(after.layers[1],{...sourceNative,id:copy.newLayerId,version:'1',layerToDocument:copy.transform});
 await variants(f,approved.preview,[after.layers[0]],after.layers);
 const request=f.command({documentId:target,expectedDocumentRevision:null,body:approved.body}),result=await terminal(f,request);assert.equal(result.json.receipt.status,'accepted',result.text);
 assert.deepEqual((await events(f,result.json.receipt)).map(e=>e.type),['DocumentCreated']);assert.equal((await document(f,target)).revision,'1');assert.deepEqual(await image(f,target),after);
 assert.deepEqual(await document(f),c.before);assert.deepEqual(await image(f),c.beforeState);await unchangedNative(f,sourceNative,identity);
 assert.deepEqual((await terminal(f,request)).json.receipt,result.json.receipt);assert.deepEqual(await f.effects(),effects);
});

for(const mutation of ['changed','deleted','locked'])test('J17 fresh new-document recovery copies frozen native versions after live native '+mutation,{timeout:180000},async t=>{
 const f=await fixture(t),c=await candidate(f),sourceNative=c.beforeState.layers.find(layer=>layer.id==='native_text'),identity=await nativeIdentity(f,sourceNative);
 const originalPlan=await retained(f,c.review.textTreatment.plan),originalSource=await retained(f,c.draft.source.pixels),effects=await f.effects();
 if(mutation==='changed'){
  const edited=await addNativeText(f,{textValue:'B',layerVersion:sourceNative.version});
  assert.notDeepEqual(edited.source,sourceNative.source);assert.equal(JSON.parse(await retained(f,edited.source)).text.textUtf8.hash,sha('B'));
 }else if(mutation==='deleted')await run(f,{type:'DeleteLayer',layerId:sourceNative.id,layerVersion:sourceNative.version,draft:null});
 else await properties(f,sourceNative.id,{locked:true});
 const current=await document(f),currentState=await image(f);assert.notEqual(current.revision,c.before.revision);
 // A fresh command fence cannot rebase the old same-document preservation plan.
 await reject(f,placement(c),{code:'STALE_REVISION'});
 const copy={sourceLayerId:sourceNative.id,newLayerId:'recovered_native',transform:[1,0,0,1,32,48]},target='recovered_'+mutation;
 const body=placement(c,{action:'new-document',preservation:'none',nativeCopies:[copy]},{placement:'new-document',newDocumentId:target}),approved=await reviewed(f,body);
 assert.equal(approved.preview.documentRevision,current.revision);assert.deepEqual(approved.preview.source,current.image);
 const prepared=JSON.parse(await retained(f,approved.preview.plan)),after=JSON.parse(await retained(f,approved.preview.after.state));
 assert.deepEqual(prepared.sourceCapture,c.selected.manifest.plan.capture);assert.deepEqual(prepared.requestPlan.sourcePixels,c.draft.source.pixels);
 assert.deepEqual(JSON.parse(await retained(f,prepared.lineage)).result.request.textTreatment,c.review.textTreatment);
 assert.deepEqual(after.layers.map(layer=>layer.id),['generated',copy.newLayerId]);assert.deepEqual(after.layers[1],{...sourceNative,id:copy.newLayerId,version:'1',layerToDocument:copy.transform});
 await variants(f,approved.preview,[after.layers[0]],after.layers);
 const request=f.command({documentId:target,expectedDocumentRevision:null,body:approved.body}),result=await terminal(f,request);assert.equal(result.json.receipt.status,'accepted',result.text);
 assert.deepEqual((await events(f,result.json.receipt)).map(event=>event.type),['DocumentCreated']);assert.deepEqual(await image(f,target),after);
 assert.deepEqual(await document(f),current);assert.deepEqual(await image(f),currentState);await unchangedNative(f,sourceNative,identity);
 assert.deepEqual(await retained(f,c.review.textTreatment.plan),originalPlan);assert.deepEqual(await retained(f,c.draft.source.pixels),originalSource);
 assert.deepEqual((await terminal(f,request)).json.receipt,result.json.receipt);assert.deepEqual(await f.effects(),effects);
 if(mutation==='deleted'){
  const aloneTarget='recovered_candidate_alone',alone=await reviewed(f,placement(c,{action:'new-document',preservation:'none',nativeCopies:[],newLayerId:'candidate_alone'},{placement:'new-document',newDocumentId:aloneTarget}));
  const aloneState=JSON.parse(await retained(f,alone.preview.after.state));assert.deepEqual(aloneState.layers.map(layer=>[layer.id,layer.kind]),[['candidate_alone','image']]);
  const accepted=await terminal(f,f.command({documentId:aloneTarget,expectedDocumentRevision:null,body:alone.body}));assert.equal(accepted.json.receipt.status,'accepted',accepted.text);
  assert.deepEqual(await image(f,aloneTarget),aloneState);assert.deepEqual(await document(f),current);assert.deepEqual(await image(f),currentState);assert.deepEqual(await f.effects(),effects);
 }
});

test('J17 full-root preservation requires explicit baked native hiding and retains exact exterior through undo',{timeout:180000},async t=>{
 const f=await fixture(t),c=await candidate(f,{kind:'baked-lettering'}),original=await pixels(f,c.before.image.compositeAssetId),effects=await f.effects();
 // A full-root result contains the visible native contribution. The writer
 // cannot hide its original as an unacknowledged side effect of preservation.
 await reject(f,placement(c,{action:'keep-both',duplicationAcknowledgement:randomUUID(),preservation:'full-visible-root'}),{code:'INVALID_INPUT',reason:'TEXT_TREATMENT_HIDE_NOT_REVIEWED'});
 const approved=await reviewed(f,placement(c,{action:'hide-native-originals',duplicationAcknowledgement:c.plan.choice.duplicationAcknowledgement,hideNativeIds:['native_text'],preservation:'full-visible-root'}));
 const after=JSON.parse(await retained(f,approved.preview.after.state));assert.deepEqual(after.layers.map(l=>[l.id,l.visible]),[['background',false],['native_text',false],['hidden_picture',false],['generated',true]]);
 for(const before of c.beforeState.layers){const next=after.layers.find(l=>l.id===before.id);assert.deepEqual(next,before.visible?{...before,version:String(BigInt(before.version)+1n),visible:false}:before);}
 const applied=await run(f,approved.body);assert.deepEqual(applied.events.map(e=>e.type),['ImageEdited']);exterior(await pixels(f,applied.document.image.compositeAssetId),original,await retained(f,c.draft.mask.requestPlan.effectiveMask));
 await run(f,{type:'Undo',historyHead:applied.document.historyHead});assert.deepEqual(await image(f),c.beforeState);
 await run(f,{type:'Redo',historyNode:applied.document.historyHead});assert.deepEqual(await image(f),after);assert.deepEqual(await f.effects(),effects);
});

test('J17 supports immutable deferred treatment review and refuses omitted, forged or mismatched placement without native mutation',{timeout:180000},async t=>{
 const f=await fixture(t),c=await candidate(f),body=placement(c),effects=await f.effects();
 const {textTreatment,...ordinary}=body;
 for(const type of ['PrepareCandidateAdoption','ReviewCandidatePlacement'])await reject(f,{...ordinary,type},{code:'INVALID_INPUT',reason:'TEXT_TREATMENT_PLACEMENT_REVIEW_REQUIRED'});
 const native=c.beforeState.layers.find(layer=>layer.kind==='text'),identity=await nativeIdentity(f,native),beforeHistory=(await f.read('/api/v1/documents/'+documentId+'/history')).json;
 const deferred=await run(f,{...body,type:'ReviewCandidatePlacement'});
 assert.deepEqual(deferred.events.map(event=>event.type),['AssetRegistered','AssetRegistered','AssetRegistered','CandidatePlacementReviewPrepared']);
 for(const event of deferred.events){assert.equal(event.commandId,deferred.request.command.commandId);assert.equal(event.transactionId,deferred.receipt.transactionId);}
 const reference=deferred.events.at(-1).payload,response=await f.read('/api/v1/image-edit-reviews/'+reference.reviewId);assert.equal(response.status,200,response.text);assert(Buffer.byteLength(response.text)<=65536);
 const deferredReview=response.json;assert.doesNotThrow(()=>candidatePlacementReview(deferredReview));const {reviewHash,...reviewContent}=deferredReview;
 assert.equal(reviewHash,sha(canonical(reviewContent)));assert.deepEqual(reference,{reviewId:deferredReview.reviewId,reviewHash});assert.equal(deferredReview.documentRevision,c.before.revision);assert.deepEqual(deferredReview.source,c.before.image);const {type:preparedType,...placementBody}=body;assert.equal(preparedType,'PrepareCandidateAdoption');assert.deepEqual(deferredReview.placement,placementBody);
 const lettering=deferredReview.lettering;assert.deepEqual(lettering.plan,textTreatment.plan);assert.deepEqual(lettering.choice,textTreatment.choice);
 const intent=JSON.parse(await retained(f,lettering.intent)),comparison=JSON.parse(await retained(f,lettering.manifest));assert.equal(lettering.intentHash,lettering.intent.hash);assert.equal(intent.kind,'candidate-lettering-intent-1');assert.deepEqual(intent.placement,deferredReview.placement);assert.deepEqual(intent.source,c.before.image);
 assert.equal(comparison.kind,'candidate-lettering-comparison-manifest-1');assert.deepEqual(comparison.intent,lettering.intent);assert.deepEqual(comparison.grid,{width:512,height:512});assert.equal(comparison.preservation,'not-applied');
 const ids=[lettering.candidateAloneAssetId,lettering.nativeOffAssetId,lettering.nativeOnAssetId];assert.equal(new Set(ids).size,3);assert.deepEqual(deferred.events.slice(0,3).map(event=>event.payload.asset.id),ids);
 const nativeIds=new Set(c.beforeState.layers.filter(layer=>layer.kind==='text'&&layer.visible).map(layer=>layer.id));
 for(const [index,kind]of ['candidate-alone','native-off','native-on'].entries()){
  const value=await asset(f,ids[index]),manifest=JSON.parse(await retained(f,value.raster.manifest)),expected=index===0?[{assetId:deferredReview.inputs.identity.preparedAssetId,transform:[1,0,0,1,0,0],opacity:1,mask:null}]:intent.after.layers.filter(layer=>nativeIds.has(layer.id)?index===2:layer.visible).map(layer=>({assetId:layer.assetId,transform:layer.layerToDocument,opacity:layer.opacity,mask:layer.mask}));
  assert.equal(value.qualification,'canonical-png');assert.equal(value.blob.mediaType,'image/png');assert(value.raster.width<=1024&&value.raster.height<=1024);assert.equal((await retained(f,value.raster.pixels)).length,value.raster.width*value.raster.height*4);
  assert.equal(manifest.plan.kind,'candidate-lettering-comparison-v1');assert.equal(manifest.plan.comparison,kind);assert.equal(manifest.plan.preservation,'not-applied');assert.deepEqual(manifest.plan.layers,expected);assert.deepEqual(comparison.images[index],{comparison:kind,assetId:value.id,blob:value.blob,raster:value.raster});
 }
 assert.deepEqual(await document(f),c.before);assert.deepEqual(await image(f),c.beforeState);assert.deepEqual((await f.read('/api/v1/documents/'+documentId+'/history')).json,beforeHistory);await unchangedNative(f,native,identity);assert.deepEqual(await f.effects(),effects);
 assert.deepEqual((await terminal(f,deferred.request)).json.receipt,deferred.receipt,'Exact review command replay preserves its accepted immutable receipt');
 assert.deepEqual((await f.read('/api/v1/image-edit-reviews/'+reference.reviewId)).json,deferredReview);
 await malformed(f,{...body,placement:'new-document',newDocumentId:'wrong_choice_document'});
 await malformed(f,{...body,newLayerId:'different_output'});
 const input=Object.fromEntries(['id','inventory','choice','beforeSource','afterSource','prompt','edit'].map(key=>[key,structuredClone(c.plan[key])]));input.id=randomUUID();
 const forged=planTextTreatment(input),forgedAsset=await stage(f,Buffer.from(canonical(forged)),'text','application/octet-stream'),envelope=bindTextTreatmentEnvelope(forged,{...forgedAsset.blob,mediaType:'application/json'});
 // Valid canonical plan, valid hash and real retained object: the writer must
 // compare the immutable accepted queue envelope, not just parse this plan.
 await reject(f,{...body,textTreatment:{...textTreatment,plan:envelope}},{code:'STALE_REVISION',reason:'TEXT_TREATMENT_REQUEST_CHANGED'});
 await properties(f,'native_text',{locked:true});const locked=(await image(f)).layers.find(l=>l.id==='native_text');
 await reject(f,body);assert.deepEqual((await image(f)).layers.find(l=>l.id==='native_text'),locked,'rejection cannot unlock native originals');
 assert.deepEqual(await f.effects(),effects);
});

for(const placementKind of ['current-document','new-document'])test('J17 reviewed 512-to-256 contained output keeps the exact treatment and native identities in '+placementKind,{timeout:180000},async t=>{
 const f=await fixture(t,{actualSize:256}),c=await candidate(f,{mapped:true,placement:placementKind}),target=placementKind==='new-document'?'mapped_text_document':null,native=c.beforeState.layers.find(layer=>layer.id==='native_text'),identity=await nativeIdentity(f,native),effects=await f.effects();
 assert.deepEqual(c.draft.mask.requestPlan.outputToDocument,[0.75,0,0,0.75,0,0]);assert.equal((await asset(f,c.value.preparedAssetId)).raster.width,256);
 const actualOutput={width:256,height:256,clipMask:false},copy={sourceLayerId:native.id,newLayerId:'copied_native',transform:[1,0,0,1,32,48]};
 const body=target?placement(c,{action:'new-document',preservation:'none',nativeCopies:[copy]},{placement:placementKind,newDocumentId:target,actualOutput}):placement(c,{}, {actualOutput});
 await reject(f,{...body,actualOutput:{...actualOutput,width:512}},{code:'INCOMPATIBLE',reason:'OUTPUT_MAPPING_REVIEW_REQUIRED'});
 // An accepted eager preview permanently reserves its generated layer ID.
 // Keep this independent zero-loss review separate from the adoption below.
 const zeroChoice={...body.textTreatment.choice,newLayerId:'zero_loss_generated',approvalId:randomUUID()},zeroBody={...body,newLayerId:zeroChoice.newLayerId,actualOutput:{...actualOutput,clipMask:true},textTreatment:{...body.textTreatment,choice:zeroChoice}};
 const zeroLoss=await reviewed(f,zeroBody),zeroPlan=JSON.parse(await retained(f,zeroLoss.preview.plan));assert.deepEqual(zeroPlan.coverage,{originalEffectivePixels:64,effectivePixels:64,lostPixels:0});assert.deepEqual(zeroPlan.outputMapping.effectiveMask,c.draft.mask.requestPlan.effectiveMask);successorWitness(c,zeroChoice,zeroPlan.identity,zeroPlan.outputMapping,zeroPlan.textTreatmentMaskSuccessor);
 const approved=await reviewed(f,body),prepared=JSON.parse(await retained(f,approved.preview.plan)),after=JSON.parse(await retained(f,approved.preview.after.state));
 assert.deepEqual(prepared.requestPlan,c.draft.mask.requestPlan);assert.deepEqual(prepared.outputMapping.outputToDocument,[1.5,0,0,1.5,0,0]);assert.deepEqual(prepared.outputMapping.effectiveMask,c.draft.mask.requestPlan.effectiveMask);assert.equal(prepared.outputMapping.resolution,'already-contained');assert.equal(prepared.coverage.lostPixels,0);assert.equal('textTreatmentMaskSuccessor' in prepared,false);
 assert.deepEqual(JSON.parse(await retained(f,prepared.lineage)).result.request.textTreatment,c.review.textTreatment);
 const generated=after.layers.find(layer=>layer.id==='generated'),wrapper=await asset(f,generated.assetId);assert.equal(wrapper.raster.width,512);assert.equal(wrapper.raster.height,512);assert.deepEqual(generated.layerToDocument,[1,0,0,1,0,0]);
 exterior(await pixels(f,generated.assetId),await pixels(f,c.selected.asset.id),await retained(f,c.draft.mask.requestPlan.effectiveMask));
 if(target){
  assert.deepEqual(after.layers.map(layer=>layer.id),['generated',copy.newLayerId]);assert.deepEqual(after.layers[1],{...native,id:copy.newLayerId,version:'1',layerToDocument:copy.transform});
  const request=f.command({documentId:target,expectedDocumentRevision:null,body:approved.body}),result=await terminal(f,request);assert.equal(result.json.receipt.status,'accepted',result.text);assert.deepEqual((await events(f,result.json.receipt)).map(event=>event.type),['DocumentCreated']);assert.deepEqual(await image(f,target),after);assert.deepEqual(await document(f),c.before);assert.deepEqual(await image(f),c.beforeState);assert.deepEqual((await terminal(f,request)).json.receipt,result.json.receipt);
 }else{
  const original=await pixels(f,c.before.image.compositeAssetId),applied=await run(f,approved.body);assert.deepEqual(applied.events.map(event=>event.type),['ImageEdited']);assert.deepEqual(await image(f),after);assert.deepEqual(after.layers.find(layer=>layer.id===native.id),native);exterior(await pixels(f,applied.document.image.compositeAssetId),original,await retained(f,c.draft.mask.requestPlan.effectiveMask));
  const undo=await run(f,{type:'Undo',historyHead:applied.document.historyHead});assert.deepEqual(await image(f),c.beforeState);assert.deepEqual(await pixels(f,undo.document.image.compositeAssetId),original);await run(f,{type:'Redo',historyNode:applied.document.historyHead});assert.deepEqual(await image(f),after);
 }
 await unchangedNative(f,native,identity);assert.deepEqual(await f.effects(),effects);
});


for(const placementKind of ['current-document','new-document'])test('J17 clipped actual output preserves all final-mask exterior cells and native identities in '+placementKind,{timeout:180000},async t=>{
 const f=await fixture(t,{actualSize:256}),c=await candidate(f,{mapped:true,cropSize:512,maskRect:{x:0,y:128,width:8,height:8},placement:placementKind}),target=placementKind==='new-document'?'clipped_text_document':null,native=c.beforeState.layers.find(layer=>layer.id==='native_text'),identity=await nativeIdentity(f,native),effects=await f.effects(),frozenPlan=await retained(f,c.review.textTreatment.plan);
 assert.deepEqual(c.draft.mask.requestPlan.outputToDocument,[1,0,0,1,0,0]);
 const actualOutput={width:256,height:256,clipMask:true},copy={sourceLayerId:native.id,newLayerId:'copied_native',transform:[1,0,0,1,32,48]},body=target?placement(c,{action:'new-document',preservation:'none',nativeCopies:[copy]},{placement:placementKind,newDocumentId:target,actualOutput}):placement(c,{}, {actualOutput});
 await reject(f,{...body,actualOutput:{...actualOutput,clipMask:false}},{code:'INCOMPATIBLE',reason:'MASK_DOMAIN_REVIEW_REQUIRED'});
 const approved=await reviewed(f,body),prepared=JSON.parse(await retained(f,approved.preview.plan)),after=JSON.parse(await retained(f,approved.preview.after.state)),coverage=await clippedBoundary(f,c,prepared.outputMapping,prepared.coverage);
 successorWitness(c,body.textTreatment.choice,prepared.identity,prepared.outputMapping,prepared.textTreatmentMaskSuccessor);assert.deepEqual(JSON.parse(await retained(f,prepared.lineage)).result.request.textTreatment,c.review.textTreatment);
 const generated=after.layers.find(layer=>layer.id==='generated'),wrapper=await asset(f,generated.assetId),{manifest,lineage}=await preservedCandidate(f,wrapper);assert.deepEqual(manifest.plan.requestPlan,c.draft.mask.requestPlan);assert.deepEqual(manifest.plan.outputMapping,prepared.outputMapping);assert.deepEqual(lineage.result.request.textTreatment,c.review.textTreatment);assert.equal(wrapper.raster.width,512);assert.equal(wrapper.raster.height,512);assert.deepEqual(generated.layerToDocument,[1,0,0,1,0,0]);
 for(const ref of [c.draft.mask.requestPlan.effectiveMask,prepared.outputMapping.effectiveMask])assert(manifest.dependencies.some(dependency=>canonical(dependency)===canonical(ref)),'Prepared raster must root both accepted and final masks');
 exterior(await pixels(f,generated.assetId),await pixels(f,c.selected.asset.id),coverage.final);
 // Acceptance must reread/prove its retained successor dependencies, including
 // cells that were in M but have become protected exterior in M'.
 for(const ref of [approved.preview.plan,prepared.outputMapping.effectiveMask]){const path=objectPath(f,ref),original=await retained(f,ref),changed=Buffer.from(original);changed[0]^=1;try{await writeFile(path,changed);await reject(f,approved.body,{target});}finally{await writeFile(path,original);}}
 if(target){
  const request=f.command({documentId:target,expectedDocumentRevision:null,body:approved.body}),result=await terminal(f,request);assert.equal(result.json.receipt.status,'accepted',result.text);assert.deepEqual((await events(f,result.json.receipt)).map(event=>event.type),['DocumentCreated']);assert.deepEqual(await image(f,target),after);assert.deepEqual(after.layers[1],{...native,id:copy.newLayerId,version:'1',layerToDocument:copy.transform});assert.deepEqual(await document(f),c.before);assert.deepEqual(await image(f),c.beforeState);assert.deepEqual((await terminal(f,request)).json.receipt,result.json.receipt);
 }else{
  const original=await pixels(f,c.before.image.compositeAssetId),applied=await run(f,approved.body);assert.deepEqual(await image(f),after);assert.deepEqual(after.layers.find(layer=>layer.id===native.id),native);exterior(await pixels(f,applied.document.image.compositeAssetId),original,coverage.final);
  const undo=await run(f,{type:'Undo',historyHead:applied.document.historyHead});assert.deepEqual(await image(f),c.beforeState);assert.deepEqual(await pixels(f,undo.document.image.compositeAssetId),original);await run(f,{type:'Redo',historyNode:applied.document.historyHead});assert.deepEqual(await image(f),after);
 }
 await unchangedNative(f,native,identity);assert.deepEqual(await retained(f,c.review.textTreatment.plan),frozenPlan);assert.deepEqual(await retained(f,c.draft.mask.requestPlan.effectiveMask),coverage.original);assert.deepEqual(await f.effects(),effects);
});

test('J17 clipped actual-output review refuses an empty successor without altering the accepted treatment',{timeout:180000},async t=>{
 const f=await fixture(t,{actualSize:256}),c=await candidate(f,{mapped:true,cropSize:512,maskRect:{x:0,y:128,width:1,height:8}}),plan=await retained(f,c.review.textTreatment.plan),mask=await retained(f,c.draft.mask.requestPlan.effectiveMask),effects=await f.effects();
 await reject(f,placement(c,{}, {actualOutput:{width:256,height:256,clipMask:true}}),{code:'INCOMPATIBLE',reason:'EMPTY_MASK'});assert.deepEqual(await retained(f,c.review.textTreatment.plan),plan);assert.deepEqual(await retained(f,c.draft.mask.requestPlan.effectiveMask),mask);assert.deepEqual(await f.effects(),effects);
});

for(const clipMask of [false,true])for(const placementKind of ['current-document','new-document'])test('J17 '+placementKind+' commit rejects inventory changed after its '+(clipMask?'clipped':'contained')+' eager treatment preview',{timeout:180000},async t=>{
 const f=await fixture(t,{actualSize:256}),c=await candidate(f,{placement:placementKind,mapped:true,...(clipMask?{cropSize:512,maskRect:{x:0,y:128,width:8,height:8}}:{})}),target=placementKind==='new-document'?'stale_text_document':null;
 const body=target?placement(c,{action:'new-document',preservation:'none',nativeCopies:[{sourceLayerId:'native_text',newLayerId:'copied_native',transform:[1,0,0,1,8,12]}]},{placement:placementKind,newDocumentId:target,actualOutput:{width:256,height:256,clipMask}}):placement(c,{}, {actualOutput:{width:256,height:256,clipMask}}),approved=await reviewed(f,body),effects=await f.effects();
 // Hidden and otherwise unrelated rows are part of the exact reviewed inventory.
 await properties(f,'hidden_picture',{locked:false});
 await reject(f,approved.body,{code:'STALE_REVISION',target});
 assert.deepEqual((await image(f)).layers.find(l=>l.id==='native_text'),c.beforeState.layers.find(l=>l.id==='native_text'));assert.deepEqual(await f.effects(),effects);
});

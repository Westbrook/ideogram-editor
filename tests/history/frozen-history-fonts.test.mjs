import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {setup,upload,workspace,edit,doc,copy,preview} from '../portable/helpers.mjs';
import {importRaster,terminal} from '../raster/helpers.mjs';
import {canonical} from '../../dist/local/server/storage/canonical.js';
import {verificationBudget} from '../../dist/local/src/protocol/text-budget.js';

const sessionId='frozen_fonts',nativeId='native_text',frame={width:64,height:32};
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const identify=value=>({...value,id:hash(canonical(value))});
const objectPath=(f,ref)=>join(f.root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
const image=async(f,id='document_1')=>(await f.read('/api/v1/documents/'+id+'/image')).json;
async function retained(f,ref){const bytes=await readFile(objectPath(f,ref));assert.equal(hash(bytes),ref.hash);assert.equal(String(bytes.length),ref.byteLength);return bytes;}
const metadata=async(f,ref)=>JSON.parse(await retained(f,ref));
async function stage(f,bytes,purpose='text',mediaType='application/octet-stream'){
  const staged=await upload(f,bytes,purpose,mediaType);
  return (await workspace(f,{type:'FinalizeStaging',stagingId:staged.stagingId,expectedSha256:staged.sha256})).event.payload.asset;
}
async function put(f,bytes,mediaType){return {...(await stage(f,bytes)).blob,mediaType};}
async function ui(f,body){
  const current=(await f.read('/api/v1/ui/'+sessionId)).json;
  const response=await f.post('/api/v1/ui/'+sessionId,{protocolVersion:1,requestId:randomUUID(),sessionId,expectedUISeq:current.uiSeq,body});
  assert.equal(response.json.status,'accepted',response.text);return response.json;
}
async function events(f,receipt){
  const response=await f.read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n));assert.equal(response.status,200,response.text);
  const batch=response.json.batches[0];if(batch.kind==='inline')return batch.events;
  const content=await f.read(batch.content.url);assert.equal(content.status,200,content.text);
  return content.text.trim().split('\n').map(line=>JSON.parse(line));
}
async function run(f,body,id='document_1',patch={}){
  const before=await doc(f,id),command=f.command({documentId:id,expectedDocumentRevision:before.revision,body,...patch});
  const response=await terminal(f,command);return {command,response,receipt:response.json.receipt};
}
async function accepted(f,body,id='document_1'){
  const result=await run(f,body,id);assert.equal(result.receipt.status,'accepted',result.response.text);
  return {...result,document:await doc(f,id),events:await events(f,result.receipt)};
}
async function rejected(f,body,id='document_1'){
  const before=await doc(f,id),state=await image(f,id),result=await run(f,body,id);
  assert.equal(result.receipt.status,'rejected',result.response.text);assert.equal(result.receipt.code,'MISSING_ASSET',result.response.text);
  assert.deepEqual(await doc(f,id),before);assert.deepEqual(await image(f,id),state);return result;
}
async function capture(f,id='document_1'){
  const before=await doc(f,id),state=await image(f,id),result=await accepted(f,{type:'PrepareRequestSource',scope:'visible-document',layerIds:[]},id);
  const asset=result.events.find(event=>event.type==='AssetRegistered').payload.asset;
  const manifest=await metadata(f,asset.raster.manifest);
  assert.equal(manifest.plan.kind,'request-source-capture-v1');assert.deepEqual(manifest.plan.capture.image,before.image);
  assert.deepEqual(manifest.plan.capture.layerIds,state.layers.filter(layer=>layer.visible).map(layer=>layer.id));
  assert.deepEqual(await doc(f,id),before);assert.deepEqual(await image(f,id),state);
  return {asset,manifest,pixels:await retained(f,asset.raster.pixels)};
}
async function nativeLayout(request,fonts){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('../../dist/local/server/text/render-worker.mjs',import.meta.url),{workerData:{request,fonts},env:{},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}});
    let result,error;const timer=setTimeout(()=>{error=Error('Native fixture render deadline');void worker.terminate();},20000);
    worker.on('message',message=>{if(message.type==='ready')worker.postMessage({type:'admit'});else if(message.type==='result')result=message;else error=Error(JSON.stringify(message));});
    worker.on('error',value=>{error=value;});worker.on('exit',code=>{clearTimeout(timer);if(error)reject(error);else if(code||!result)reject(Error('Native fixture did not exit with a result'));else resolve(result);});
  });
}
async function nativeSource(f,font,profileBytes,literal){
  const profile=JSON.parse(profileBytes),style={primaryFont:font.bytes.hash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1.2,fill:[40,90,190,0],align:'start',direction:'auto'};
  const document=await doc(f),token={documentId:document.id,documentRevision:document.revision,layerId:nativeId,layerVersion:'0',sessionId,generation:1};
  const rendered=await nativeLayout({text:literal,style,frame,token},[{path:objectPath(f,font.bytes),length:Number(font.bytes.byteLength),hash:font.bytes.hash,origin:font.origin,licenseHash:font.licenseRecord.hash}]);
  // Actual nonempty native layout, with an independently known transparent
  // contribution. The opaque backdrop makes source capture nonempty.
  const textUtf8=(await stage(f,Buffer.from(literal),'caption','text/plain')).blob;
  const layout=await put(f,Buffer.from(rendered.layout),'application/json'),pixels=await put(f,Buffer.alloc(frame.width*frame.height*4),'application/x-ideogram-rgba8');
  assert.equal(rendered.textHash,textUtf8.hash);assert.equal(rendered.layoutHash,layout.hash);assert.equal(rendered.rasterHash,pixels.hash);
  assert(JSON.parse(rendered.layout).paragraphs.some(paragraph=>paragraph.runs.length>0));
  const manifest=await put(f,profileBytes,'application/json'),text=identify({schemaVersion:1,textUtf8,style,frame,layoutPolicy:'text-layout-1',fonts:[font]});
  const dependencyHash=hash(JSON.stringify({rendererProfile:profile.id,textHash:textUtf8.hash,style,frame,fonts:[{hash:font.bytes.hash,licenseHash:font.licenseRecord.hash,faceIndex:0,format:font.format,parserProfile:font.parserProfile,fsType:font.fsType}]}));
  const render=identify({schemaVersion:1,textVersion:text.id,rendererProfile:{schemaVersion:1,id:profile.id,manifest},dependencyHash,layout,pixels,width:rendered.width,height:rendered.height,overflow:rendered.overflow,resolvedFonts:[font.id]});
  return {schemaVersion:1,text,render};
}
async function preparedText(f,source,profile,{create=false}={}){
  const document=await doc(f),layer=(await image(f)).layers.find(layer=>layer.id===nativeId),draftId='draft_'+randomUUID();
  const token={documentId:document.id,documentRevision:document.revision,layerId:nativeId,layerVersion:create?'0':layer.version,sessionId,generation:1};
  const candidate=await put(f,Buffer.from(canonical({schemaVersion:1,token,source})),'application/json');
  const draft=await stage(f,Buffer.from(canonical({schemaVersion:1,kind:'text-draft-1',textUtf8:source.text.textUtf8,style:source.text.style,frame:source.text.frame,fonts:source.text.fonts})),'caption','text/plain');
  await ui(f,{type:'SaveDraft',draft:{id:draftId,generation:'1',kind:'text',documentId:document.id,targetLayerId:create?null:nativeId,expectedDocumentRevision:document.revision,assetId:draft.id,composing:false}});
  const literal=(await retained(f,source.text.textUtf8)).toString(),budget=verificationBudget(literal,frame.width,frame.height,source.text.fonts.reduce((sum,font)=>sum+Number(font.bytes.byteLength),0),profile.engine.wasm.bytes);
  const admissionId=randomUUID()+'_1_'+budget.bytes;assert.equal((await f.post('/api/v1/text-admission/'+admissionId,{protocolVersion:1})).status,200);
  const body={type:create?'CreateTextLayer':'CommitTextEdit',layerId:nativeId,...(create?{name:'Frozen native text'}:{layerVersion:layer.version,reviewedDependencyHash:source.render.dependencyHash}),candidate,draft:{sessionId,draftId,generation:'1'},admissionId};
  return {document,body,release:async()=>assert.equal((await f.post('/api/v1/text-admission/'+admissionId+'/release',{protocolVersion:1})).status,200)};
}
async function fixture(t){
  // Close the server before rootFor's earlier-registered filesystem cleanup.
  let f;t.after(async()=>{if(f)await f.server.close();});f=await setup(t);
  assert.equal((await terminal(f,f.command({},frame))).json.receipt.status,'accepted');
  const black=(await importRaster(f,'black.png')).asset;await edit(f,{type:'ImportAsset',assetId:black.id,layerId:'backdrop',name:'Opaque backdrop',draft:null});
  const profileBytes=await readFile('src/text/profile.json'),profile=JSON.parse(profileBytes),bundled=profile.fonts.find(font=>font.id==='NotoSans');
  const bytes=(await stage(f,await readFile('vendor/text/'+bundled.file),'font','application/octet-stream')).blob,license=(await stage(f,await readFile('vendor/text/'+bundled.licenseFile),'caption','text/plain')).blob;
  const font=(await edit(f,{type:'ImportFont',source:bytes,license,origin:'bundled',embeddingReviewed:true})).event.payload.asset.font;
  const source=await nativeSource(f,font,profileBytes,'Café'),prepared=await preparedText(f,source,profile,{create:true});
  try{const result=await run(f,prepared.body,'document_1',{sessionId});assert.equal(result.receipt.status,'accepted',result.response.text);}finally{await prepared.release();}
  const original=await doc(f),originalState=await image(f),layer=originalState.layers.find(layer=>layer.id===nativeId);
  assert.deepEqual(await metadata(f,layer.source),source);
  return {f,font,source,profile,profileBytes,original,originalState,sourceRef:layer.source};
}
async function without(f,ref,work,{corrupt=false}={}){
  const path=objectPath(f,ref),saved=await readFile(path);
  if(corrupt){const changed=Buffer.from(saved);changed[0]^=255;await writeFile(path,changed,{mode:0o600});}else await unlink(path);
  try{return await work();}finally{await writeFile(path,saved,{mode:0o600});}
}

test('missing native font permits exact Undo, Redo, branch switching and source capture while edit/copy remain strict',async t=>{
  const {f,font,source,profile,profileBytes,original,originalState,sourceRef}=await fixture(t);
  const changed=(await accepted(f,{type:'SetLayerProperties',layerId:nativeId,layerVersion:'1',properties:{opacity:0.5},draft:null})).document,changedState=await image(f);
  await accepted(f,{type:'Undo',historyHead:changed.historyHead});
  const branched=(await accepted(f,{type:'SetLayerProperties',layerId:nativeId,layerVersion:'1',properties:{name:'Alternate branch'},draft:null})).document,branchedState=await image(f);
  assert.notEqual(branched.branchId,changed.branchId);
  // Render a real changed candidate while its font exists, then bind a fresh
  // draft/token only after navigation. Missing-font rejection cannot be stale.
  const replacement=await nativeSource(f,font,profileBytes,'Other');
  const baseline=await capture(f);
  let editAttempt;
  await without(f,font.bytes,async()=>{
    const undone=await accepted(f,{type:'Undo',historyHead:branched.historyHead});assert.deepEqual(undone.document.image,original.image);assert.deepEqual(await image(f),originalState);
    const redone=await accepted(f,{type:'Redo',historyNode:branched.historyHead});assert.deepEqual(redone.document.image,branched.image);assert.deepEqual(await image(f),branchedState);
    const switched=await accepted(f,{type:'SwitchBranch',branchId:changed.branchId,historyNode:changed.historyHead});assert.deepEqual(switched.document.image,changed.image);assert.deepEqual(await image(f),changedState);
    await accepted(f,{type:'SwitchBranch',branchId:branched.branchId,historyNode:branched.historyHead});
    assert.deepEqual((await image(f)).layers.find(layer=>layer.id===nativeId).source,sourceRef);assert.deepEqual(await metadata(f,sourceRef),source);
    const frozen=await capture(f);assert.deepEqual(frozen.pixels,baseline.pixels);assert.deepEqual(frozen.asset.raster.pixels,baseline.asset.raster.pixels);
    await rejected(f,{type:'SaveCopy'});
    const prepared=await preparedText(f,replacement,profile);
    try{
      const before=await doc(f);editAttempt=await run(f,prepared.body,'document_1',{sessionId});
      assert.equal(editAttempt.receipt.status,'rejected',editAttempt.response.text);assert.equal(editAttempt.receipt.code,'MISSING_ASSET',editAttempt.response.text);
      assert.deepEqual(await doc(f),before);assert.deepEqual(await image(f),branchedState);
    }finally{await prepared.release();}
  });
  // Restoring exact bytes and freshly preparing the same replacement succeeds;
  // the missing-font command itself remains an immutable rejected receipt.
  assert.deepEqual((await terminal(f,editAttempt.command)).json.receipt,editAttempt.receipt);
  const restored=await preparedText(f,replacement,profile);
  try{const result=await run(f,restored.body,'document_1',{sessionId});assert.equal(result.receipt.status,'accepted',result.response.text);}finally{await restored.release();}
});

for(const damage of ['license','profile','pixels','corrupt-font'])test('frozen history/capture reject '+damage+' damage without mutating the document',async t=>{
  const {f,font,source,original}=await fixture(t);
  const changed=(await accepted(f,{type:'SetLayerProperties',layerId:nativeId,layerVersion:'1',properties:{opacity:0.5},draft:null})).document;
  await accepted(f,{type:'Undo',historyHead:changed.historyHead});
  const ref=damage==='license'?font.licenseRecord:damage==='profile'?source.render.rendererProfile.manifest:damage==='pixels'?source.render.pixels:font.bytes;
  await without(f,ref,async()=>{
    const before=await doc(f);assert.deepEqual(before.image,original.image);
    await rejected(f,{type:'Undo',historyHead:before.historyHead});
    await rejected(f,{type:'Redo',historyNode:changed.historyHead});
    await rejected(f,{type:'SwitchBranch',branchId:changed.branchId,historyNode:changed.historyHead});
    await rejected(f,{type:'PrepareRequestSource',scope:'visible-document',layerIds:[]});
  },{corrupt:damage==='corrupt-font'});
});

test('imported captured native ancestry keeps its exact metadata when the local font bytes disappear',async t=>{
  const {f,font,sourceRef}=await fixture(t),captured=await capture(f);
  await accepted(f,{type:'ImportAsset',assetId:captured.asset.id,layerId:'captured',name:'Captured native ancestry',draft:null});
  const native=(await image(f)).layers.find(layer=>layer.id===nativeId);
  await accepted(f,{type:'DeleteLayer',layerId:native.id,layerVersion:native.version,draft:null});
  const saved=await copy(f);
  await f.server.close(); // Release the source writer before admitting the fresh target store.
  let target;t.after(async()=>{if(target)await target.server.close();});target=await setup(t);
  const reviewed=await preview(target,saved.bytes);assert.equal(reviewed.review.editable,true,canonical(reviewed.review));
  await workspace(target,{type:'ImportBundle',reviewId:reviewed.review.reviewId,reviewHash:reviewed.review.reviewHash});
  const id=reviewed.review.documentId,before=await doc(target,id),state=await image(target,id);
  assert.equal(state.layers.some(layer=>layer.kind==='text'),false);
  const importedLayer=state.layers.find(layer=>layer.name==='Captured native ancestry');assert(importedLayer);
  const imported=(await target.read('/api/v1/assets/'+importedLayer.assetId)).json.projection.value;
  assert(imported.retainedMetadata,'Imported capture must traverse original namespace metadata');
  const originalMetadata=await metadata(target,sourceRef),baseline=await capture(target,id);
  await without(target,font.bytes,async()=>{
    const frozen=await capture(target,id);assert.deepEqual(frozen.pixels,baseline.pixels);
    const undone=await accepted(target,{type:'Undo',historyHead:before.historyHead},id);
    assert((await image(target,id)).layers.some(layer=>layer.kind==='text'));
    const redone=await accepted(target,{type:'Redo',historyNode:before.historyHead},id);assert.deepEqual(redone.document.image,before.image);assert.deepEqual(await image(target,id),state);
    assert.notEqual(undone.document.historyHead,before.historyHead);
    assert.deepEqual(await metadata(target,sourceRef),originalMetadata);
    await rejected(target,{type:'SaveCopy'},id);
  });
});

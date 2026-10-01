import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setup,rootFor,command,pair,call,cookieFrom,readHeaders,mutationHeaders} from '../protocol/helpers.mjs';
import {importRaster,operate,terminal} from '../raster/helpers.mjs';
import {upload,copy,preview as previewCopy,workspace} from '../portable/helpers.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {newDraft,bindRequestMask,confirmRequestMask} from '../../dist/local/src/request/core.js';

const doc=async(f,id='document_1')=>(await f.read('/api/v1/documents/'+id)).json.projection.value;
const state=async(f,id='document_1')=>(await f.read('/api/v1/documents/'+id+'/image')).json;
async function fixtureSetup(t){let f;t.after(()=>f?.server.close());f=await setup(t);return f;}
async function retained(f,ref){const bytes=await readFile(join(f.root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7)));assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),ref.hash);assert.equal(String(bytes.length),ref.byteLength);return bytes;}
async function pixels(f,id){const asset=(await f.read('/api/v1/assets/'+id)).json.projection.value;return retained(f,asset.raster.pixels);}
async function events(f,receipt){const page=await f.read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n));assert.equal(page.status,200,page.text);assert.equal(page.json.batches[0].kind,'inline');return page.json.batches[0].events;}
async function run(f,body,id='document_1'){
  const current=await doc(f,id),request=f.command({documentId:id,expectedDocumentRevision:current.revision,body}),result=await terminal(f,request);
  assert.equal(result.json.receipt.status,'accepted',result.text);
  return {request,receipt:result.json.receipt,events:await events(f,result.json.receipt),document:await doc(f,id)};
}
async function reject(f,body,code,id='document_1',revision=undefined){
  const before=await doc(f,id),result=await terminal(f,f.command({documentId:id,expectedDocumentRevision:revision===undefined?before.revision:revision,body}));
  assert.equal(result.json.receipt.status,'rejected',result.text);assert.equal(result.json.receipt.code,code,result.text);assert.deepEqual(await doc(f,id),before);return result.json.receipt;
}
async function capture(f,scope,layerIds=[]){
  const before=await doc(f),result=await run(f,{type:'PrepareRequestSource',scope,layerIds}),asset=result.events[0].payload.asset;
  assert.deepEqual(await doc(f),before);assert.equal(result.receipt.documentRevision,before.revision);assert.equal(result.events.length,1);
  const manifest=(await f.read('/api/v1/assets/'+asset.id+'/raster')).json;
  assert.equal(manifest.plan.kind,'request-source-capture-v1');assert.deepEqual(manifest.plan.capture.image,before.image);
  return {asset,manifest,source:{assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:asset.raster.width,height:asset.raster.height,scope,documentRevision:before.revision,capture:asset.raster.manifest}};
}
async function layer(f,name,fixture){const {asset}=await importRaster(f,fixture);await run(f,{type:'ImportAsset',assetId:asset.id,layerId:name,name,draft:null});return asset;}
async function properties(f,id,value){const l=(await state(f)).layers.find(l=>l.id===id);return run(f,{type:'SetLayerProperties',layerId:id,layerVersion:l.version,properties:value,draft:null});}

test('all source scopes retain exact transformed masked contributions and immutable ordered capture identities',async t=>{
  const f=await fixtureSetup(t);assert.equal((await terminal(f,f.command({}, {width:3,height:2}))).json.receipt.status,'accepted');
  await layer(f,'bottom','black.png');await layer(f,'picture','hidden-alpha.png');await layer(f,'hidden','white.png');
  await properties(f,'hidden',{visible:false});
  const mask=(await operate(f,{type:'PrepareMask',plan:{width:3,height:2,feather:0,operations:[{kind:'shape',shape:{kind:'rectangle',x:1,y:0,width:1,height:2},mode:'replace'}]}})).event.payload.asset;
  await run(f,{type:'ApplyTransform',layerId:'picture',layerVersion:'1',transform:[1,0,0,1,1,0],draft:null});
  await properties(f,'picture',{opacity:0.5,mask:{assetId:mask.id,mapping:'document-r16-v1',inverted:false},locked:true});
  const before=await doc(f),beforeState=await state(f),single=await capture(f,'single-layer',['picture']);
  const contribution=Buffer.alloc(24);contribution.set([0,0,255,32],16);
  assert.deepEqual(await pixels(f,single.asset.id),contribution);
  const visible=await capture(f,'visible-document'),selected=await capture(f,'selected-layers',['hidden','picture']),hidden=await capture(f,'single-layer',['hidden']);
  const visiblePixels=Buffer.from(contribution);visiblePixels.set([0,0,0,255],0);
  const selectedPixels=Buffer.from(contribution);selectedPixels.set([255,255,255,255],0);
  const hiddenPixels=Buffer.alloc(24);hiddenPixels.set([255,255,255,255],0);
  assert.deepEqual(await pixels(f,visible.asset.id),visiblePixels);assert.deepEqual(await pixels(f,visible.asset.id),await pixels(f,before.image.compositeAssetId));
  assert.deepEqual(await pixels(f,selected.asset.id),selectedPixels);assert.deepEqual(await pixels(f,hidden.asset.id),hiddenPixels);
  for(const [result,ids] of [[single,['picture']],[visible,['bottom','picture']],[selected,['picture','hidden']],[hidden,['hidden']]]){
    assert.deepEqual(result.manifest.plan.capture.layerIds,ids);assert.equal(result.manifest.plan.capture.documentRevision,before.revision);
    assert.deepEqual(JSON.parse(await retained(f,result.manifest.plan.capture.image.state)),beforeState);
    assert.deepEqual(result.manifest.plan.layers,beforeState.layers.filter(l=>ids.includes(l.id)).map(l=>({assetId:l.assetId,transform:l.layerToDocument,opacity:l.opacity,mask:l.mask})));
  }
  await properties(f,'picture',{locked:false});await properties(f,'picture',{opacity:1,mask:null});
  assert.deepEqual(await pixels(f,single.asset.id),contribution);assert.deepEqual(JSON.parse(await retained(f,single.manifest.plan.capture.image.state)),beforeState);
  assert.deepEqual((await f.read('/api/v1/assets/'+single.asset.id+'/raster')).json,single.manifest);
  const closure=(await f.read('/api/v1/documents/document_1/closure')).json.items;
  for(const ref of [single.asset.raster.pixels,single.asset.raster.manifest,before.image.state,mask.raster.manifest])assert(closure.some(item=>item.hash===ref.hash),ref.hash);
});

test('source capture rejects empty, missing and stale selections without changing accepted image state',async t=>{
  const f=await fixtureSetup(t);await terminal(f,f.command({}, {width:3,height:2}));
  await reject(f,{type:'PrepareRequestSource',scope:'visible-document',layerIds:[]},'INVALID_INPUT');
  await layer(f,'picture','hidden-alpha.png');const before=await doc(f);
  await properties(f,'picture',{name:'Current name'});
  await reject(f,{type:'PrepareRequestSource',scope:'single-layer',layerIds:['picture']},'STALE_REVISION','document_1',before.revision);
  await reject(f,{type:'PrepareRequestSource',scope:'selected-layers',layerIds:['picture','missing']},'STALE_REVISION');
});

// The provider boundary is the only substitute. These fixtures run actual HTTP,
// queue, result decoding, source/mask preparation, reviews and history commits.
async function providerFixture(t,mode){
  // Provider teardown records its final resource state inside this root.
  let server;t.after(()=>server?.close());
  const root=await rootFor(t),module=mode==='inpaint'?'../request-edits/observer-fixture.mjs':'../candidates/observer-fixture.mjs';
  server=await startLocalServer({root},{writer:{setupModule:new URL(module,import.meta.url).href}});
  const paired=await pair(server);assert.equal(paired.status,200,paired.text);
  const recoveryIds=new Set();
  const f={root,server,paired,read:async path=>{const response=await call(server.origin,path,{headers:readHeaders(cookieFrom(paired))});if(response.json?.recovery?.recoveryId)recoveryIds.add(response.json.recovery.recoveryId);return response;},post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body)};
  f.releaseReadLeases=async()=>{for(const id of recoveryIds)assert.equal((await f.post('/api/v1/recovery/'+id+'/release',{protocolVersion:1})).status,204);recoveryIds.clear();};
  assert.equal((await terminal(f,f.command({}, {width:512,height:512}))).json.receipt.status,'accepted');
  f.effects=async()=>{const value=JSON.parse(await readFile(join(root,mode==='inpaint'?'request-edits-fixture.json':'candidate-fixture.json'),'utf8'));assert.deepEqual(value.errors,[]);return value.effects;};
  return f;
}
async function caption(f,text){const stage=await upload(f,Buffer.from(text),'caption','text/plain');return (await operate(f,{type:'FinalizeStaging',stagingId:stage.stagingId,expectedSha256:stage.sha256})).event.payload.asset;}
async function ui(f,body){const session='request_edits',current=(await f.read('/api/v1/ui/'+session)).json;const request={protocolVersion:1,requestId:randomUUID(),sessionId:session,expectedUISeq:current.uiSeq,body},result=await f.post('/api/v1/ui/'+session,request);assert.equal(result.json.status,'accepted',result.text);return {request,value:result.json};}
async function candidate(f,source=null,feather=0){
  const prompt=await caption(f,'Retained local adoption fixture'),draft=newDraft(prompt.blob);Object.assign(draft.fields,{width:'512',height:'512'});
  if(source){
    const asset=(await operate(f,{type:'PrepareRequestMask',sourceAssetId:source.assetId,plan:{width:512,height:512,feather,operations:[{kind:'shape',shape:{kind:'rectangle',x:1,y:1,width:1,height:1},mode:'replace'}]},clip:null})).event.payload.asset;
    const manifest=(await f.read('/api/v1/assets/'+asset.id+'/raster')).json;
    const mask={assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:512,height:512,sourceHash:source.pixels.hash,polarity:'white-edit',fullAcknowledged:false,empty:false,full:false,plan:asset.raster.manifest,binding:bindRequestMask(source)};
    mask.requestPlan=confirmRequestMask(source,mask,manifest.plan.hard,manifest.plan.effective,randomUUID());
    draft.operation='inpaint';draft.fields.size='auto';draft.fields.strength='1';draft.source=source;draft.mask=mask;
  }
  const asset=await caption(f,JSON.stringify(draft));
  await ui(f,{type:'SaveDraft',draft:{id:'request',generation:'1',kind:'request',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:(await doc(f)).revision,assetId:asset.id,composing:false}});
  const prepared=await ui(f,{type:'PrepareRequestReview',draftId:'request',generation:'1'}),review=prepared.value.review;
  const accepted=await ui(f,{type:'AcceptRequestReview',reviewId:review.id,token:review.token});
  const queued=await operate(f,{type:'QueueInference',reviewId:review.id,token:review.token,acceptanceId:accepted.request.requestId}),jobId=queued.event.payload.id;
  let value;
  const deadline=Date.now()+20000;
  do{const response=await f.read('/api/v1/jobs/'+jobId+'/candidates');if(response.status===200)value=response.json.items[0];if(value?.state==='prepared')break;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<deadline);
  assert.equal(value?.state,'prepared',JSON.stringify(value));return {value,draft};
}
const adoption=(candidate,patch={})=>({type:'PrepareCandidateAdoption',candidateId:candidate.id,mode:'safe-region',placement:'current-document',newDocumentId:null,actualOutput:null,newLayerId:randomUUID(),name:'Reviewed candidate',...patch});
async function reviewed(f,body){const prepared=await run(f,body),preview=prepared.events.at(-1).payload.preview;const r=await run(f,{type:'ReviewImageEdit',previewId:preview.previewId});const review=(await f.read('/api/v1/image-edit-reviews/'+r.events.at(-1).payload.reviewId)).json;return {preview,review,body:{type:'AdoptCandidate',previewId:preview.previewId,reviewId:review.reviewId,reviewHash:review.reviewHash,draft:null}};}
async function createFromReview(f,approved,id){const request=f.command({documentId:id,expectedDocumentRevision:null,body:approved.body}),result=await terminal(f,request);assert.equal(result.json.receipt.status,'accepted',result.text);const committed=await events(f,result.json.receipt);assert.deepEqual(committed.map(e=>e.type),['DocumentCreated']);assert.equal(committed[0].documentId,id);assert.equal(result.json.receipt.documentRevision,'1');return {request,receipt:result.json.receipt,document:await doc(f,id)};}

test('single-layer safe adoption keeps its stack slot and exact exterior through atomic Undo and Redo',async t=>{
  const f=await providerFixture(t,'inpaint');await layer(f,'picture','hidden-alpha.png');await properties(f,'picture',{opacity:0.5});await layer(f,'overlay','white.png');
  const before=await doc(f),originalState=await state(f),original=await pixels(f,before.image.compositeAssetId),captured=await capture(f,'single-layer',['picture']);
  const {value:c,draft}=await candidate(f,captured.source),approved=await reviewed(f,adoption(c,{newLayerId:'replacement'})),effects=await f.effects();
  assert.deepEqual(await doc(f),before);const applied=await run(f,approved.body),next=await state(f);
  assert.deepEqual(applied.events.map(e=>e.type),['ImageEdited']);assert.deepEqual(next.layers.map(l=>[l.id,l.visible]),[['picture',false],['replacement',true],['overlay',true]]);
  assert.deepEqual(next.layers[0],{...originalState.layers[0],version:'3',visible:false});assert.deepEqual(next.layers[2],originalState.layers[1]);
  assert.deepEqual(next.layers[1].layerToDocument,[1,0,0,1,0,0]);assert.equal(next.layers[1].opacity,1);assert.equal(next.layers[1].mask,null);
  const result=await pixels(f,applied.document.image.compositeAssetId),coverage=await retained(f,draft.mask.requestPlan.effectiveMask);
  for(let at=0;at<coverage.length;at+=2)if(coverage.readUInt16LE(at)===0)assert.deepEqual(result.subarray(at*2,at*2+4),original.subarray(at*2,at*2+4));
  assert.deepEqual([...result.subarray((512+1)*4,(512+2)*4)],[36,104,172,255]);
  const undone=await run(f,{type:'Undo',historyHead:applied.document.historyHead});assert.deepEqual(await state(f),originalState);assert.deepEqual(await pixels(f,undone.document.image.compositeAssetId),original);
  const redone=await run(f,{type:'Redo',historyNode:applied.document.historyHead});assert.deepEqual(await state(f),next);assert.equal(redone.document.image.compositeAssetId,approved.preview.after.compositeAssetId);
  await reject(f,approved.body,'STALE_REVISION');assert.deepEqual(await f.effects(),effects);
});

test('selected-layer candidate rejects unsafe replacement and remains available for a fresh new-document review after source changes',async t=>{
  const f=await providerFixture(t,'inpaint');await layer(f,'picture','hidden-alpha.png');await layer(f,'overlay','white.png');
  const captured=await capture(f,'selected-layers',['picture']),{value:c,draft}=await candidate(f,captured.source,2);
  await reject(f,adoption(c),'INCOMPATIBLE');await properties(f,'picture',{locked:true});
  const changed=await doc(f),changedState=await state(f),target='selected_candidate',approved=await reviewed(f,adoption(c,{placement:'new-document',newDocumentId:target,newLayerId:'output'})),effects=await f.effects();
  const created=await createFromReview(f,approved,target);assert.deepEqual(await doc(f),changed);assert.deepEqual(await state(f),changedState);
  const output=await state(f,target);assert.equal(output.layers.length,1);assert.equal(output.layers[0].id,'output');assert.equal(output.composition,undefined);assert.equal(created.document.revision,'1');
  assert.deepEqual(await pixels(f,created.document.image.compositeAssetId),await pixels(f,approved.preview.preparedAssetId));
  assert.deepEqual((await terminal(f,created.request)).json.receipt,created.receipt);assert.deepEqual(await f.effects(),effects);
  const fullTarget='selected_full_candidate',fullReview=await reviewed(f,adoption(c,{mode:'full-candidate',placement:'new-document',newDocumentId:fullTarget,newLayerId:'full_output'}));
  const fullCreated=await createFromReview(f,fullReview,fullTarget),fullPixels=await pixels(f,fullCreated.document.image.compositeAssetId);
  const plan=draft.mask.requestPlan,refs=[plan.sourcePixels,plan.authoredMask,plan.effectiveMask],bytes=await Promise.all(refs.map(ref=>retained(f,ref)));
  assert.notEqual(plan.authoredMask.hash,plan.effectiveMask.hash,'Feathered coverage must exercise two independently retained objects');
  const closure=(await f.read('/api/v1/documents/'+fullTarget+'/closure')).json.items;
  for(const ref of refs)assert(closure.some(item=>item.hash===ref.hash),ref.hash);
  // Remove both the origin and its preserved-output sibling so only the full
  // candidate document supplies the adoption history ownership checked here.
  await f.releaseReadLeases();
  const deletionCommand=async body=>{const result=await terminal(f,f.command({documentId:null,expectedDocumentRevision:null,body}));assert.equal(result.json.receipt.status,'accepted',result.text);};
  for(const id of [target,'document_1']){
    await deletionCommand({type:'PreviewDocumentDeletion',documentId:id,expectedRevision:(await doc(f,id)).revision});
    const deletion=(await f.read('/api/v1/documents/'+id+'/deletion')).json.plan;
    await deletionCommand({type:'DeleteDocument',documentId:id,planId:deletion.id,planHash:deletion.planHash,rootGeneration:deletion.rootGeneration,expectedRevision:deletion.documentRevision,acknowledgeRunningAndUncertain:false});
    assert.equal((await f.read('/api/v1/documents/'+id)).status,404);
    await deletionCommand({type:'CollectDocumentGarbage',documentId:id});
    assert.equal((await f.read('/api/v1/documents/'+id+'/deletion')).json.receipt.status,'cleanup-complete');
  }
  const retainedClosure=(await f.read('/api/v1/documents/'+fullTarget+'/closure')).json.items;
  for(const [index,ref] of refs.entries()){assert(retainedClosure.some(item=>item.hash===ref.hash),ref.hash);assert.deepEqual(await retained(f,ref),bytes[index]);}
  assert.deepEqual(await doc(f,fullTarget),fullCreated.document);assert.deepEqual(await pixels(f,fullCreated.document.image.compositeAssetId),fullPixels);assert.deepEqual(await f.effects(),effects);
});

test('generated candidate creates an independent root with reusable pixels, checkpoint navigation and portable history',async t=>{
  const f=await providerFixture(t,'generate'),before=await doc(f),{value:c}=await candidate(f),target='generated_document';
  const encoded=(await f.read('/api/v1/assets/'+c.encodedAssetId)).json.projection.value,normalized=(await f.read('/api/v1/assets/'+c.preparedAssetId)).json.projection.value;
  assert.equal(encoded.qualification,'pending-decoder');assert.equal(encoded.safety,'unknown');assert.equal(normalized.safety,'safe');
  const approved=await reviewed(f,adoption(c,{mode:'full-candidate',placement:'new-document',newDocumentId:target,newLayerId:'generated'})),created=await createFromReview(f,approved,target),effects=await f.effects();
  assert.deepEqual(await doc(f),before);const root=(await f.read('/api/v1/documents/'+target+'/history')).json.items[0];assert.equal(root.parent,null);assert.deepEqual(root.forward.after,created.document);
  const original=await pixels(f,created.document.image.compositeAssetId);assert.deepEqual(original.subarray(0,4),Buffer.from([36,104,172,255]));
  const rejection=await reject(f,{type:'ImportAsset',assetId:c.preparedAssetId,layerId:'generated',name:'Duplicate identity',draft:null},'INVALID_INPUT',target);
  assert.equal(JSON.parse(await retained(f,rejection.details)).issues[0].code,'LAYER_ID_REUSE');
  await run(f,{type:'SaveCheckpoint',name:'Generated root'},target);
  const changed=await run(f,{type:'SetLayerProperties',layerId:'generated',layerVersion:'1',properties:{opacity:0.5},draft:null},target);
  await run(f,{type:'Undo',historyHead:changed.document.historyHead},target);assert.deepEqual(await pixels(f,(await doc(f,target)).image.compositeAssetId),original);
  await run(f,{type:'Redo',historyNode:changed.document.historyHead},target);
  await run(f,{type:'SwitchBranch',branchId:root.branchId,historyNode:root.id},target);assert.deepEqual(await pixels(f,(await doc(f,target)).image.compositeAssetId),original);
  const archive=await copy(f,target),review=(await previewCopy(f,archive.bytes)).review;assert.equal(review.editable,true,JSON.stringify(review));
  await workspace(f,{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash});
  const imported=await doc(f,review.documentId);assert.deepEqual(await pixels(f,imported.image.compositeAssetId),original);assert.notEqual(imported.historyHead,root.id);
  // The untouched origin has no Document.image yet. Its explicit full-candidate
  // preview still carries an empty source version and must remain applicable.
  assert.equal((await doc(f)).image,undefined);
  const additive=await reviewed(f,adoption(c,{mode:'full-candidate',newLayerId:'added_generated'})),added=await run(f,additive.body);
  assert.deepEqual(added.events.map(event=>event.type),['ImageEdited']);assert.deepEqual((await state(f)).layers.map(layer=>layer.id),['added_generated']);
  assert.deepEqual(await pixels(f,added.document.image.compositeAssetId),original);
  await run(f,{type:'Undo',historyHead:added.document.historyHead});assert.deepEqual((await state(f)).layers,[]);assert.equal((await doc(f)).image.compositeAssetId,null);
  const restored=await run(f,{type:'Redo',historyNode:added.document.historyHead});assert.equal(restored.document.image.compositeAssetId,additive.preview.after.compositeAssetId);
  assert.deepEqual(await f.effects(),effects);
});

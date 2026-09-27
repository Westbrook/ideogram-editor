import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from '../protocol/helpers.mjs';
import {importRaster,operate,terminal,binary} from '../raster/helpers.mjs';
import sharp from 'sharp';
const doc=async f=>(await f.read('/api/v1/documents/document_1')).json.projection.value;
const state=async f=>(await f.read('/api/v1/documents/document_1/image')).json;
async function edit(f,body){const d=await doc(f),r=await terminal(f,f.command({expectedDocumentRevision:d.revision,body}));assert.equal(r.json.receipt.status,'accepted',r.text);return doc(f);}
const pixels=async(f,id)=>sharp((await binary(f,id)).bytes).ensureAlpha().raw().toBuffer();
test('typed R16 mask preparation, exact CP-1 attachment, stale/lock refusal, Undo and retained closure',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Original',draft:null});
 const before=await doc(f),plan={width:3,height:2,feather:2,operations:[{kind:'shape',shape:{kind:'rectangle',x:1,y:0,width:1,height:2},mode:'replace'}]};
 const prepared=await operate(f,{type:'PrepareMask',plan}),mask=prepared.event.payload.asset;assert.equal(mask.raster.role,'mask');assert.equal((await doc(f)).revision,before.revision);
 const m=(await f.read('/api/v1/assets/'+mask.id+'/raster')).json;assert.equal(m.plan.kind,'authored-mask-v1');assert.equal(m.plan.hard.byteLength,'12');assert.equal(m.plan.effective.byteLength,'12');assert.deepEqual(m.plan.statistics,{hardPixels:2,effectivePixels:6,support:{x:0,y:0,width:3,height:2}});
 const changed=await edit(f,{type:'SetLayerProperties',layerId:'picture',layerVersion:'1',properties:{mask:{assetId:mask.id,mapping:'document-r16-v1',inverted:false}},draft:null});
 const b=await pixels(f,changed.image.compositeAssetId);assert.deepEqual([...b],[0,0,0,0,255,0,0,48,0,255,0,48,0,0,255,12,255,255,255,96,0,0,0,48]);
 const sampled=(await f.read('/api/v1/assets/'+changed.image.compositeAssetId+'/sample?x=1&y=0')).json;assert.deepEqual(sampled.rgba,[255,0,0,48]);assert.equal(sampled.color,'sRGB');assert.equal((await f.read('/api/v1/assets/'+changed.image.compositeAssetId+'/sample?x=3&y=0')).status,400);
 const stale=await terminal(f,f.command({expectedDocumentRevision:before.revision,body:{type:'SetLayerProperties',layerId:'picture',layerVersion:'1',properties:{mask:null},draft:null}}));assert.equal(stale.json.receipt.status,'rejected');
 const restored=await edit(f,{type:'Undo',historyHead:changed.historyHead});assert.equal(restored.image.compositeAssetId,before.image.compositeAssetId);
 await edit(f,{type:'Redo',historyNode:changed.historyHead});let layer=(await state(f)).layers[0];await edit(f,{type:'SetLayerProperties',layerId:layer.id,layerVersion:layer.version,properties:{locked:true},draft:null});layer=(await state(f)).layers[0];
 const lock=await terminal(f,f.command({expectedDocumentRevision:(await doc(f)).revision,body:{type:'SetLayerProperties',layerId:layer.id,layerVersion:layer.version,properties:{mask:null},draft:null}}));assert.equal(lock.json.receipt.status,'rejected');
 const closure=(await f.read('/api/v1/documents/document_1/closure')).json;for(const ref of [m.plan.hard,m.plan.effective,mask.raster.manifest])assert(closure.items.some(r=>r.hash===ref.hash));
});

test('PNG mask alignment, inversion, source closure, complete copy/import, reopen and exact export',async t=>{
 const {copy,preview,workspace,doc:document}=await import('../portable/helpers.mjs');
 const {startLocalServer}=await import('../../dist/local/server/http.js');
 const {call,cookieFrom,readHeaders,mutationHeaders}=await import('../protocol/helpers.mjs');
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const {asset,input}=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Original',draft:null});
 const plan={width:3,height:2,feather:0,operations:[{kind:'import',assetId:asset.id,x:0,y:0,width:3,height:2,inverted:true}]};
 const mask=(await operate(f,{type:'PrepareMask',plan})).event.payload.asset;await edit(f,{type:'SetLayerProperties',layerId:'picture',layerVersion:'1',properties:{mask:{assetId:mask.id,mapping:'document-r16-v1',inverted:false}},draft:null});
 const before=await doc(f),beforePixels=await pixels(f,before.image.compositeAssetId);
 const bundle=await copy(f),review=(await preview(f,bundle.bytes)).review;assert.equal(review.editable,true,JSON.stringify(review));await workspace(f,{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash});
 const imported=await document(f,review.documentId);assert.deepEqual(await pixels(f,imported.image.compositeAssetId),beforePixels);
 const mapped=(await f.read('/api/v1/documents/'+imported.id+'/image')).json;assert.equal(mapped.layers[0].mask.mapping,'document-r16-v1');
 const nested=await copy(f,imported.id),second=(await preview(f,nested.bytes)).review;assert.equal(second.editable,true);
 const closure=(await f.read('/api/v1/documents/document_1/closure')).json;assert(closure.items.some(r=>r.hash===input.blob.hash));
 const cookie=cookieFrom(f.paired);await f.server.close();const server=await startLocalServer({root:f.root});t.after(()=>server.close());
 const paired=await call(server.origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:server.origin,Cookie:cookie},body:{protocolVersion:1,pairingToken:new URL(server.issuePairingURL()).hash.slice(9)}});
 const g={server,paired,read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))}),post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),command:(patch,body)=>f.command({...patch,clientId:paired.json.clientId},body)};
 assert.deepEqual(await pixels(g,(await document(g,imported.id)).image.compositeAssetId),beforePixels);
 const exp=await terminal(g,g.command({documentId:imported.id,expectedDocumentRevision:imported.revision,body:{type:'ExportDocument',historyHead:imported.historyHead}}));assert.equal(exp.json.receipt.status,'accepted');
});

test('unapplied imported mask draft retains exact caption and source bindings across nested copies',async t=>{
 const {randomUUID}=await import('node:crypto');const {copy,preview,workspace,upload,doc:document,binary:download}=await import('../portable/helpers.mjs');
 const f=await setup(t);await terminal(f,f.command({}, {width:3,height:2}));const {asset}=await importRaster(f,'hidden-alpha.png');
 const value={schema:'local-mask-1',layerVersion:'1',radius:'invalid radius retained',plan:{width:3,height:2,feather:0,operations:[{kind:'import',assetId:asset.id,x:0,y:0,width:3,height:2,inverted:false}]}},bytes=Buffer.from(JSON.stringify(value)),stage=await upload(f,bytes,'caption','text/plain'),caption=(await workspace(f,{type:'FinalizeStaging',stagingId:stage.stagingId,expectedSha256:stage.sha256})).event.payload.asset;
 const saved=await f.post('/api/v1/ui/masks',{protocolVersion:1,requestId:randomUUID(),sessionId:'masks',expectedUISeq:'0',body:{type:'SaveDraft',draft:{id:'unfinished',generation:'1',kind:'mask',documentId:'document_1',targetLayerId:null,expectedDocumentRevision:'1',assetId:caption.id,composing:false}}});assert.equal(saved.json.status,'accepted',saved.text);
 let documentId='document_1';for(let i=0;i<2;i++){
  const bundle=await copy(f,documentId),review=(await preview(f,bundle.bytes)).review;assert.equal(review.editable,true);await workspace(f,{type:'ImportBundle',reviewId:review.reviewId,reviewHash:review.reviewHash});documentId=review.documentId;
  const ui=(await f.read('/api/v1/ui/'+review.uiSessionIds[0])).json,draft=ui.drafts[0];assert.equal(draft.kind,'mask');assert.deepEqual((await download(f,'/api/v1/assets/'+draft.assetId+'/content')).bytes,bytes);assert.notEqual(draft.maskBindings[asset.id],asset.id);
  const plan={...value.plan,operations:value.plan.operations.map(op=>({...op,assetId:draft.maskBindings[op.assetId]}))};const prepared=(await operate(f,{type:'PrepareMask',plan})).event.payload.asset;assert.equal(prepared.raster.role,'mask');assert.equal((await document(f,documentId)).orderedLayerIds.length,0);
 }
});

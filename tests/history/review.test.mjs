import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {setup,call,cookieFrom,readHeaders,mutationHeaders} from '../protocol/helpers.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {importRaster,terminal,binary} from '../raster/helpers.mjs';
const doc=async f=>(await f.read('/api/v1/documents/document_1')).json.projection.value;
const state=async f=>(await f.read('/api/v1/documents/document_1/image')).json;
async function run(f,body){const d=await doc(f),c=f.command({expectedDocumentRevision:d.revision,body}),r=await terminal(f,c);assert.equal(r.json.receipt.status,'accepted',r.text);const page=await f.read('/api/v1/events?after='+String(BigInt(r.json.receipt.fromSeq)-1n));return {c,receipt:r.json.receipt,events:page.json.batches[0].events,document:await doc(f)};}
const rgba=async(f,id)=>{const r=await binary(f,id);assert.equal(r.status,200);return sharp(r.bytes,{ignoreIcc:true}).ensureAlpha().raw().toBuffer();};
async function review(f,previewId){const prepared=await run(f,{type:'ReviewImageEdit',previewId});const response=await f.read('/api/v1/image-edit-reviews/'+prepared.events.at(-1).payload.reviewId);assert.equal(response.status,200,response.text);return response.json;}
async function seed(t){const f=await setup(t);await terminal(f,f.command({}, {width:2,height:2}));const white=await importRaster(f,'white.png');await run(f,{type:'ImportAsset',assetId:white.asset.id,layerId:'white',name:'Original',draft:null});return {f,white};}
test('previewed intrinsic image resampling creates new pixels only after explicit approval; exact versions survive undo/redo and stale review',async t=>{
 const {f,white}=await seed(t),before=await doc(f),original=await rgba(f,before.image.compositeAssetId);
 const p=await run(f,{type:'PrepareImageResample',layerId:'white',layerVersion:'1',width:2,height:2}),preview=p.events.at(-1).payload.preview;
 assert.deepEqual(await doc(f),before);assert.equal(preview.kind,'resample-image');assert.deepEqual((await f.read('/api/v1/image-previews/'+preview.previewId)).json,preview);
 // CP-1 triangle support has transparent zero extension: each resized white
 // sample has 0.75*0.75 coverage, Q8 alpha143, without edge renormalization.
 assert.deepEqual(await rgba(f,preview.preparedAssetId),Buffer.from([255,255,255,143,255,255,255,143,255,255,255,143,255,255,255,143]));
 const r=await review(f,preview.previewId),applied=await run(f,{type:'ResampleImage',previewId:preview.previewId,reviewId:r.reviewId,reviewHash:r.reviewHash,draft:null});
 assert.equal(applied.events.length,1);assert.equal(applied.document.image.compositeAssetId,preview.after.compositeAssetId);
 let s=await state(f);assert.equal(s.layers[0].id,'white');assert.equal(s.layers[0].assetId,preview.preparedAssetId);assert.equal(s.layers[0].version,'2');assert.deepEqual(s.layers[0].layerToDocument,[1,0,0,1,0,0]);
 const undone=await run(f,{type:'Undo',historyHead:applied.document.historyHead});assert.deepEqual(await rgba(f,undone.document.image.compositeAssetId),original);assert.equal((await state(f)).layers[0].assetId,white.asset.id);
 await run(f,{type:'Redo',historyNode:applied.document.historyHead});assert.equal((await state(f)).layers[0].assetId,preview.preparedAssetId);
 const stale=f.command({expectedDocumentRevision:(await doc(f)).revision,body:{type:'ResampleImage',previewId:preview.previewId,reviewId:r.reviewId,reviewHash:r.reviewHash,draft:null}});assert.equal((await terminal(f,stale)).json.receipt.code,'STALE_REVISION');
 const roots=(await f.read('/api/v1/documents/document_1/closure')).json.items;assert(roots.some(x=>x.hash===white.input.blob.hash));assert(roots.some(x=>x.hash===preview.after.state.hash));
});
test('flatten-copy review freezes selected stacking and actual full preview; hide is explicit, originals and branch remain',async t=>{
 const {f}=await seed(t),black=await importRaster(f,'black.png');await run(f,{type:'ImportAsset',assetId:black.asset.id,layerId:'black',name:'Black',draft:null});
 await run(f,{type:'MoveLayers',orderedLayerIds:['black','white'],draft:null});await run(f,{type:'SetLayerProperties',layerId:'white',layerVersion:'1',properties:{opacity:0.1},draft:null});
 const before=await doc(f),beforePixels=await rgba(f,before.image.compositeAssetId);assert.deepEqual(beforePixels,Buffer.from([90,90,90,255,0,0,0,0,0,0,0,0,0,0,0,0]));
 const p=await run(f,{type:'PrepareFlattenedCopy',layerIds:['white','black'],includeHidden:false,hideOriginals:true,newLayerId:'flattened',name:'Explicit copy'}),preview=p.events.at(-1).payload.preview;
 assert.deepEqual(await doc(f),before);assert.deepEqual(await rgba(f,preview.preparedAssetId),beforePixels);assert.deepEqual(await rgba(f,preview.after.compositeAssetId),beforePixels);
 const r=await review(f,preview.previewId),applied=await run(f,{type:'CreateFlattenedCopy',previewId:preview.previewId,reviewId:r.reviewId,reviewHash:r.reviewHash,draft:null});
 const s=await state(f);assert.deepEqual(s.layers.map(l=>[l.id,l.visible]),[['black',false],['white',false],['flattened',true]]);assert.equal(s.layers[0].assetId,black.asset.id);assert.equal(s.layers[2].assetId,preview.preparedAssetId);
 const undo=await run(f,{type:'Undo',historyHead:applied.document.historyHead});assert.deepEqual(await rgba(f,undo.document.image.compositeAssetId),beforePixels);assert.deepEqual((await state(f)).layers.map(l=>l.id),['black','white']);
 const branch=await run(f,{type:'SetLayerProperties',layerId:'white',layerVersion:'2',properties:{name:'New branch'},draft:null});assert.notEqual(branch.document.branchId,applied.document.branchId);
 await run(f,{type:'SwitchBranch',branchId:applied.document.branchId,historyNode:applied.document.historyHead});assert.deepEqual(await rgba(f,(await doc(f)).image.compositeAssetId),beforePixels);
 const saved=await doc(f),cookie=cookieFrom(f.paired);await f.server.close();
 const server=await startLocalServer({root:f.root});t.after(()=>server.close());
 const paired=await call(server.origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:server.origin,Cookie:cookie},body:{protocolVersion:1,pairingToken:new URL(server.issuePairingURL()).hash.slice(9)}});
 const g={server,paired,read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))}),post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),command:(patch,body)=>f.command({...patch,clientId:paired.json.clientId},body)};
 assert.deepEqual(await doc(g),saved);assert.deepEqual((await g.read('/api/v1/image-previews/'+preview.previewId)).json,preview);
 assert.deepEqual((await terminal(g,applied.c)).json.receipt,applied.receipt);
 await run(g,{type:'Undo',historyHead:saved.historyHead});assert.deepEqual(await rgba(g,(await doc(g)).image.compositeAssetId),beforePixels);
 await run(g,{type:'Redo',historyNode:saved.historyHead});assert.equal((await state(g)).layers[2].assetId,preview.preparedAssetId);
 const exported=await run(g,{type:'ExportDocument',historyHead:saved.historyHead});assert.deepEqual(await rgba(g,exported.events.at(-1).payload.asset.id),beforePixels);
});
test('document-aligned masks remain attached through resampling and retain their grid through canvas resize',async t=>{
 const f=await setup(t);await terminal(f,f.command({}, {width:1,height:1}));const white=await importRaster(f,'white.png');
 await run(f,{type:'ImportAsset',assetId:white.asset.id,layerId:'white',name:'Original',draft:null});
 const mask={assetId:white.asset.id,mapping:'document-luminance-alpha-v1',inverted:false};
 await run(f,{type:'SetLayerProperties',layerId:'white',layerVersion:'1',properties:{mask},draft:null});
 const before=await doc(f),p=await run(f,{type:'PrepareImageResample',layerId:'white',layerVersion:'2',width:2,height:2}),preview=p.events.at(-1).payload.preview,r=await review(f,preview.previewId);
 const applied=await run(f,{type:'ResampleImage',previewId:preview.previewId,reviewId:r.reviewId,reviewHash:r.reviewHash,draft:null});
 assert.deepEqual((await state(f)).layers[0].mask,mask);assert.deepEqual(await rgba(f,applied.document.image.compositeAssetId),Buffer.from([255,255,255,143]));
 const resized=await run(f,{type:'ResizeCanvas',width:2,height:2,offsetX:0,offsetY:0,draft:null});
 assert.deepEqual((await state(f)).layers[0].mask,{...mask,mapping:'retained-luminance-alpha-v1',offsetX:0,offsetY:0,width:1,height:1,outside:'zero'});
 assert.deepEqual(await rgba(f,resized.document.image.compositeAssetId),Buffer.from([255,255,255,143,0,0,0,0,0,0,0,0,0,0,0,0]));
 await run(f,{type:'Undo',historyHead:resized.document.historyHead});assert.deepEqual((await state(f)).layers[0].mask,mask);assert.equal((await doc(f)).image.compositeAssetId,applied.document.image.compositeAssetId);
 await run(f,{type:'Undo',historyHead:applied.document.historyHead});assert.deepEqual((await state(f)).layers[0].mask,mask);assert.equal((await doc(f)).image.compositeAssetId,before.image.compositeAssetId);
});
test('review expires on session renewal, locked source refuses hiding and wrong kind cannot apply a prepared image',async t=>{
 const {f}=await seed(t);const p=await run(f,{type:'PrepareImageResample',layerId:'white',layerVersion:'1',width:2,height:2}),preview=p.events.at(-1).payload.preview,r=await review(f,preview.previewId);
 const wrong=f.command({expectedDocumentRevision:(await doc(f)).revision,body:{type:'CreateFlattenedCopy',previewId:preview.previewId,reviewId:r.reviewId,reviewHash:r.reviewHash,draft:null}});assert.equal((await terminal(f,wrong)).json.receipt.code,'INCOMPATIBLE');
 f.paired=await f.post('/api/v1/session/renew',{protocolVersion:1});assert.equal((await f.read('/api/v1/image-edit-reviews/'+r.reviewId)).status,410);
 const expired=f.command({expectedDocumentRevision:(await doc(f)).revision,body:{type:'ResampleImage',previewId:preview.previewId,reviewId:r.reviewId,reviewHash:r.reviewHash,draft:null}});assert.equal((await terminal(f,expired)).json.receipt.code,'INVALID_INPUT');
 await run(f,{type:'SetLayerProperties',layerId:'white',layerVersion:'1',properties:{locked:true},draft:null});
 const locked=f.command({expectedDocumentRevision:(await doc(f)).revision,body:{type:'PrepareFlattenedCopy',layerIds:['white'],includeHidden:false,hideOriginals:true,newLayerId:'copy',name:'Copy'}});assert.equal((await terminal(f,locked)).json.receipt.code,'INVALID_INPUT');
 const stale=f.command({expectedDocumentRevision:(await doc(f)).revision,body:{type:'ReviewImageEdit',previewId:preview.previewId}});assert.equal((await terminal(f,stale)).json.receipt.code,'STALE_REVISION');
});

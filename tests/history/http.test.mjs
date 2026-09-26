import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {setup,call,cookieFrom,readHeaders,mutationHeaders,pair} from '../protocol/helpers.mjs';
import {importRaster,terminal,binary} from '../raster/helpers.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {randomUUID} from 'node:crypto';
const readDocument=async f=>(await f.read('/api/v1/documents/document_1')).json.projection.value;
const state=async f=>(await f.read('/api/v1/documents/document_1/image')).json;
async function edit(f,body){const d=await readDocument(f),c=f.command({expectedDocumentRevision:d.revision,body});const r=await terminal(f,c);assert.equal(r.json.receipt.status,'accepted',JSON.stringify(r.json));return {command:c,receipt:r.json.receipt,document:await readDocument(f)};}
async function pixels(f,assetId){const r=await binary(f,assetId);assert.equal(r.status,200);return sharp(r.bytes,{ignoreIcc:true}).ensureAlpha().raw().toBuffer();}
async function create(f){const r=await terminal(f,f.command({}, {width:3,height:2}));assert.equal(r.json.receipt.status,'accepted');}

test('real import, transform, opacity, undo/redo, retained branch/checkpoint, restart and exact export',async t=>{
 const f=await setup(t);await create(f);const {asset,input}=await importRaster(f,'hidden-alpha.png');
 const original=Buffer.from([17,99,231,0,255,0,0,128,0,255,0,255,0,0,255,64,255,255,255,255,0,0,0,255]);
 const imported=await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Original',draft:null});
 assert.equal(BigInt(imported.receipt.toSeq)-BigInt(imported.receipt.fromSeq),1n);
 assert.deepEqual(await pixels(f,imported.document.image.compositeAssetId),original);
 const moved=await edit(f,{type:'ApplyTransform',layerId:'picture',layerVersion:'1',transform:[1,0,0,1,1,0],draft:null});
 assert.deepEqual(await pixels(f,moved.document.image.compositeAssetId),Buffer.from([0,0,0,0,17,99,231,0,255,0,0,128,0,0,0,0,0,0,255,64,255,255,255,255]));
 const faded=await edit(f,{type:'SetLayerProperties',layerId:'picture',layerVersion:'2',properties:{opacity:0.5},draft:null});
 const fadedPixels=await pixels(f,faded.document.image.compositeAssetId);
 assert.deepEqual(fadedPixels,Buffer.from([0,0,0,0,0,0,0,0,255,0,0,64,0,0,0,0,0,0,255,32,255,255,255,128]));
 const cp=await edit(f,{type:'SaveCheckpoint',name:'Half opacity'});
 assert.equal((await f.read('/api/v1/documents/document_1/save-status?sessionId=ui1')).json.documentChangedSinceCheckpoint,false);
 const undone=await edit(f,{type:'Undo',historyHead:cp.document.historyHead});assert.equal(undone.document.image.compositeAssetId,moved.document.image.compositeAssetId);
 const redone=await edit(f,{type:'Redo',historyNode:faded.document.historyHead});assert.equal(redone.document.image.compositeAssetId,faded.document.image.compositeAssetId);
 assert.equal((await f.read('/api/v1/documents/document_1/save-status?sessionId=ui1')).json.documentChangedSinceCheckpoint,false);
 assert.equal((await f.read('/api/v1/documents/document_1/save-status?sessionId=ui1')).json.bundleOutdated,true);
 await edit(f,{type:'Undo',historyHead:redone.document.historyHead});
 const branch=await edit(f,{type:'SetLayerProperties',layerId:'picture',layerVersion:'2',properties:{visible:false,name:'Hidden original'},draft:null});
 assert.notEqual(branch.document.branchId,faded.document.branchId);assert.equal(branch.document.redo,null);
 assert.deepEqual(await pixels(f,branch.document.image.compositeAssetId),Buffer.alloc(24));
 const ineligible=f.command({expectedDocumentRevision:branch.document.revision,body:{type:'Redo',historyNode:faded.document.historyHead}});
 assert.equal((await terminal(f,ineligible)).json.receipt.code,'STALE_REVISION');
 const restored=await edit(f,{type:'SwitchBranch',branchId:faded.document.branchId,historyNode:faded.document.historyHead});
 assert.deepEqual(await pixels(f,restored.document.image.compositeAssetId),fadedPixels);
 const duplicate=await terminal(f,imported.command);assert.deepEqual(duplicate.json.receipt,imported.receipt);assert.equal((await readDocument(f)).revision,restored.document.revision);
 const closure=(await f.read('/api/v1/documents/document_1/closure')).json;assert.equal(closure.kind,'live-retained-closure');
 for(const hash of [asset.blob.hash,input.blob.hash,asset.raster.pixels.hash,imported.document.image.state.hash,branch.document.image.state.hash])assert(closure.items.some(r=>r.hash===hash),hash);
 const nodes=(await f.read('/api/v1/documents/document_1/history')).json.items;assert.equal(nodes.length,5);assert(nodes.some(n=>n.id===branch.document.historyHead));
 const beforeRestart=await state(f),cookie=cookieFrom(f.paired);await f.server.close();
 const server=await startLocalServer({root:f.root});t.after(()=>server.close());
 const paired=await call(server.origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:server.origin,Cookie:cookie},body:{protocolVersion:1,pairingToken:new URL(server.issuePairingURL()).hash.slice(9)}});
 const g={server,paired,read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))}),post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),command:(patch,body)=>f.command({...patch,clientId:paired.json.clientId},body)};
 assert.deepEqual(await state(g),beforeRestart);assert.deepEqual((await terminal(g,imported.command)).json.receipt,imported.receipt);
 const exported=await edit(g,{type:'ExportDocument',historyHead:restored.document.historyHead});assert.equal(exported.document.revision,restored.document.revision);
 const event=(await g.read('/api/v1/events?after='+String(BigInt(exported.receipt.fromSeq)-1n))).json.batches[0].events[0];
 assert.equal(event.payload.asset.qualification,'canonical-png');assert.deepEqual(await pixels(g,event.payload.asset.id),fadedPixels);
});

test('concurrent revisions, deleted identity, locks, masks, crop and canvas bounds are explicit',async t=>{
 const f=await setup(t);await create(f);const {asset}=await importRaster(f,'hidden-alpha.png');await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Picture',draft:null});
 const d=await readDocument(f),commands=[0.2,0.8].map(opacity=>f.command({expectedDocumentRevision:d.revision,body:{type:'SetLayerProperties',layerId:'picture',layerVersion:'1',properties:{opacity},draft:null}}));
 const results=await Promise.all(commands.map(c=>terminal(f,c)));assert.deepEqual(results.map(r=>r.json.receipt.status).sort(),['accepted','rejected']);
 assert.equal(results.find(r=>r.json.receipt.status==='rejected').json.receipt.code,'STALE_REVISION');
 let layer=(await state(f)).layers[0];await edit(f,{type:'SetLayerProperties',layerId:'picture',layerVersion:layer.version,properties:{locked:true},draft:null});
 layer=(await state(f)).layers[0];const locked=f.command({expectedDocumentRevision:(await readDocument(f)).revision,body:{type:'ApplyTransform',layerId:'picture',layerVersion:layer.version,transform:[1,0,0,1,2,0],draft:null}});assert.equal((await terminal(f,locked)).json.receipt.code,'INVALID_INPUT');
 await edit(f,{type:'SetLayerProperties',layerId:'picture',layerVersion:layer.version,properties:{locked:false},draft:null});
 await edit(f,{type:'CropDocument',x:1,y:0,width:2,height:2,draft:null});assert.equal((await state(f)).layers[0].layerToDocument[4],-1);
 await edit(f,{type:'ResizeCanvas',width:3,height:2,offsetX:1,offsetY:0,draft:null});assert.equal((await state(f)).layers[0].layerToDocument[4],0);
 layer=(await state(f)).layers[0];await edit(f,{type:'DuplicateLayer',layerId:'picture',layerVersion:layer.version,newLayerId:'copy',name:'Copy',draft:null});
 await edit(f,{type:'MoveLayers',orderedLayerIds:['copy','picture'],draft:null});
 const deleted=await edit(f,{type:'DeleteLayer',layerId:'copy',layerVersion:'1',draft:null});assert.equal((await state(f)).layers.length,1);
 await edit(f,{type:'Undo',historyHead:deleted.document.historyHead});assert.deepEqual((await state(f)).layers.map(l=>l.id),['copy','picture']);
});
test('export freezes the selected image revision while a preceding queued edit commits, and blank export is explicit PNG',async t=>{
 const f=await setup(t);await create(f);let d=await readDocument(f);
 const blank=await edit(f,{type:'ExportDocument',historyHead:d.historyHead});
 const blankEvents=(await f.read('/api/v1/events?after='+String(BigInt(blank.receipt.fromSeq)-1n))).json.batches[0].events;
 assert.equal(blankEvents.at(-1).payload.asset.qualification,'canonical-png');assert.deepEqual(await pixels(f,blankEvents.at(-1).payload.asset.id),Buffer.alloc(24));
 const {asset}=await importRaster(f,'hidden-alpha.png');const imported=await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:'picture',name:'Picture',draft:null});d=imported.document;
 const changed=f.command({commandId:'a_edit',expectedDocumentRevision:d.revision,body:{type:'SetLayerProperties',layerId:'picture',layerVersion:'1',properties:{opacity:0.5},draft:null}});
 const exported=f.command({commandId:'z_export',expectedDocumentRevision:d.revision,body:{type:'ExportDocument',historyHead:d.historyHead}});
 assert.equal((await f.post('/api/v1/commands',changed)).status,202);assert.equal((await f.post('/api/v1/commands',exported)).status,202);
 assert.equal((await terminal(f,changed)).json.receipt.status,'accepted');const receipt=(await terminal(f,exported)).json.receipt;assert.equal(receipt.status,'accepted');assert.equal(receipt.documentRevision,d.revision);
 const result=(await f.read('/api/v1/events?after='+String(BigInt(receipt.fromSeq)-1n))).json.batches[0].events.at(-1).payload.asset;
 assert.deepEqual(await pixels(f,result.id),await pixels(f,d.image.compositeAssetId));assert.equal((await readDocument(f)).revision,String(BigInt(d.revision)+1n));
});

import {captureMaskFrame,maskAlignment,confirmRequestMask} from '../../dist/local/src/request/core.js';
import sharp from 'sharp';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fixture,prepare,enqueue,envelope,encode,auth} from './helpers.mjs';
async function finish(w,c,method){await w[method](encode(c),auth());let record;for(let i=0;i<1000&&!record;i++){record=await w.lookup(c.command.commandId);if(!record)await new Promise(r=>setTimeout(r,5));}assert.equal(record?.receipt.status,'accepted',JSON.stringify(record));return (await w.events(String(BigInt(record.receipt.fromSeq)-1n))).events.find(e=>e.commandId===c.command.commandId);}
const objectPath=(root,r)=>join(root,'objects/sha256',r.hash.slice(7,9),r.hash.slice(7));
async function sourceAsset(w){
 const bytes=await readFile('tests/raster/fixtures/hidden-alpha.png'),sha256='sha256:'+createHash('sha256').update(bytes).digest('hex'),stagingId=randomUUID();await w.assetCreate({protocolVersion:1,stagingId,purpose:'image',expectedBytes:String(bytes.length),sha256,mediaType:'image/png'},auth());const token=await w.assetBeginChunk(stagingId,'0',bytes.length,auth());await w.assetChunk(token,bytes,auth());const original=(await finish(w,envelope({type:'FinalizeStaging',stagingId,expectedSha256:sha256}),'assetCommand')).payload.asset,preview=(await finish(w,envelope({type:'PrepareRaster',assetId:original.id}),'rasterCommand')).payload.asset,reviewId=(await finish(w,envelope({type:'ReviewRaster',assetId:preview.id}),'rasterCommand')).payload.reviewId,review=await w.rasterReview(reviewId,auth()),asset=(await finish(w,envelope({type:'ApproveRaster',assetId:preview.id,reviewId,reviewHash:review.reviewHash}),'rasterCommand')).payload.asset;

 return {original,asset,bytes};
}
test('enqueue materializes approved source resize and retains original bytes',async t=>{
 const f=await fixture(t,{width:3,height:2}),w=f.writer,{original,asset,bytes}=await sourceAsset(w),document=await w.document('document_1');
 const p=await prepare(w,d=>{d.operation='transform';d.source={assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:3,height:2,scope:'asset',documentRevision:document.revision};d.fields.width='6';d.fields.height='4';d.fields.strength='0.8';d.conversion={from:{width:3,height:2},to:{width:6,height:4},mapping:'stretch',approved:true};});
 const q=await enqueue(w,p.body),stage=q.job.stagePlan[0];assert.equal(q.job.stagePlan.length,1);assert.equal(stage.role,'source');assert.deepEqual(stage.original,asset.blob);assert.notEqual(stage.transport.hash,stage.original.hash);assert.deepEqual([stage.width,stage.height],[6,4]);assert.equal('sha256:'+createHash('sha256').update(await readFile(objectPath(f.root,stage.transport))).digest('hex'),stage.transport.hash);assert.deepEqual(await readFile(objectPath(f.root,original.blob)),bytes);assert.equal(JSON.parse(await readFile(objectPath(f.root,q.job.review.template),'utf8')).image_url,'asset:'+asset.blob.hash);assert.deepEqual(q.job.review.conversion,p.review.conversion);
});
for(const feather of [0,64])test(`inpaint stages opaque binary transport from exact R16 with unchanged dimensions and feather ${feather}`,async t=>{
 const f=await fixture(t,{width:3,height:2}),w=f.writer,{original,asset,bytes}=await sourceAsset(w);
 const imported=envelope({type:'ImportAsset',assetId:asset.id,layerId:'source_layer',name:'Source',draft:null});imported.command.documentId='document_1';imported.command.expectedDocumentRevision='1';await finish(w,imported,'historyCommand');
 const a=(await finish(w,envelope({type:'PrepareMask',plan:{width:3,height:2,feather,operations:[{kind:'shape',shape:{kind:'rectangle',x:1,y:0,width:1,height:2},mode:'replace'}]}}),'rasterCommand')).payload.asset;
 const attached=envelope({type:'SetLayerProperties',layerId:'source_layer',layerVersion:'1',properties:{mask:{assetId:a.id,mapping:'document-r16-v1',inverted:false}},draft:null});attached.command.documentId='document_1';attached.command.expectedDocumentRevision='2';await finish(w,attached,'historyCommand');
 const document=await w.document('document_1'),layer=(await w.imageState('document_1')).layers[0],manifest=JSON.parse(await readFile(objectPath(f.root,a.raster.manifest),'utf8'));
 const mask={assetId:a.id,version:a.version,blob:a.blob,pixels:a.raster.pixels,width:3,height:2,sourceHash:asset.raster.pixels.hash,polarity:'white-edit',empty:false,full:feather>0,fullAcknowledged:feather>0,plan:a.raster.manifest,frame:captureMaskFrame(document,layer)};
 const effectiveBefore=await readFile(objectPath(f.root,manifest.plan.effective)),sourceBefore=await readFile(objectPath(f.root,asset.raster.pixels)),layerBefore=await readFile(objectPath(f.root,mask.blob));
 const p=await prepare(w,d=>{d.operation='inpaint';d.source={assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:3,height:2,scope:'asset',documentRevision:document.revision};mask.frame.alignment=maskAlignment(d.source,mask);mask.requestPlan=confirmRequestMask(d.source,mask,manifest.plan.hard,manifest.plan.effective,'binary-mask-review');d.mask=mask;d.fields.width='3';d.fields.height='2';d.fields.strength='0.8';});
 const q=await enqueue(w,p.body),[source,stage]=q.job.stagePlan;assert.equal(q.job.stagePlan.length,2);assert.deepEqual(source.transport,asset.blob);assert.equal(stage.role,'mask');assert.deepEqual(stage.original,mask.blob);assert.deepEqual([stage.width,stage.height],[3,2]);assert.deepEqual(q.job.review.request.mask.requestPlan,mask.requestPlan);
 const data=await sharp(objectPath(f.root,stage.transport)).raw().toBuffer(),expected=[];
 for(let i=0;i<effectiveBefore.length;i+=2){const value=effectiveBefore.readUInt16LE(i)>0?255:0;expected.push(value,value,value,255);}
 assert.deepEqual([...data],expected);
 if(feather){assert.notEqual(stage.transport.hash,mask.blob.hash);assert.ok([...Array(6).keys()].every(i=>effectiveBefore.readUInt16LE(i*2)>0&&effectiveBefore.readUInt16LE(i*2)<129));const preview=await sharp(layerBefore).raw().toBuffer();assert.ok([...Array(6).keys()].every(i=>preview[i*4]===0&&data[i*4]===255));}
 else assert.deepEqual([...data],[0,255,0,0,255,0].flatMap(v=>[v,v,v,255]));
 assert.deepEqual(await readFile(objectPath(f.root,original.blob)),bytes);assert.deepEqual(await readFile(objectPath(f.root,asset.raster.pixels)),sourceBefore);assert.deepEqual(await readFile(objectPath(f.root,mask.blob)),layerBefore);assert.deepEqual(await readFile(objectPath(f.root,manifest.plan.effective)),effectiveBefore);
 const template=JSON.parse(await readFile(objectPath(f.root,q.job.review.template),'utf8'));assert.equal(template.mask_url,'asset:'+mask.blob.hash);
 const reopened=await f.reopen(),retained=(await reopened.queueView()).jobs.find(j=>j.id===q.job.id);assert.deepEqual(retained.stagePlan,q.job.stagePlan);assert.deepEqual(retained.review.request.mask.requestPlan,mask.requestPlan);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {inspectContainer} from '../../dist/local/server/raster/container.js';
import {startLocalServer} from '../../dist/local/server/http.js';
import {setup,call,cookieFrom,mutationHeaders} from '../protocol/helpers.mjs';
import {original,operate,binary,envelope,terminal,digest} from './helpers.mjs';
const base=new URL('./png-validation/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',base)));
const reviewer=JSON.parse(await readFile(new URL('reviewer-manifest.json',base)));
const fixtures=[...manifest.fixtures,...reviewer.fixtures];

test('sealed independent PNG container/profile/stream fixtures',async t=>{
 for(const item of fixtures)await t.test(item.name,async()=>{
  const path=new URL(item.name,base).pathname,bytes=await readFile(path);
  assert.equal(bytes.length,item.bytes);assert.equal(digest(bytes),'sha256:'+item.sha256);
  if(item.valid){const result=await inspectContainer(path,'image/png');assert.equal(result.width,item.width);assert.equal(result.height,item.height);}
  else await assert.rejects(async()=>inspectContainer(path,'image/png'),/RASTER_/);
 });
});
test('public PNG rejection retains original, exact durable receipt and no usable raster through restart',async t=>{
 const f=await setup(t),retries=[];
 for(const item of fixtures.filter(x=>!x.valid))await t.test(item.name,async()=>{
  const input=await original(f,'../png-validation/'+item.name),c=envelope(f,{type:'PrepareRaster',assetId:input.id}),r=await terminal(f,c);
  assert.equal(r.json.receipt.status,'rejected',r.text);assert.equal(r.json.receipt.code,'INVALID_INPUT');
  assert.deepEqual((await f.post('/api/v1/commands',c)).json,r.json);
  assert.equal((await f.read('/api/v1/assets/'+input.id+'/content')).status,403);
  assert.equal((await f.read('/api/v1/assets/'+input.id+'/raster')).status,404);
  assert.equal(digest(await readFile(join(f.root,'objects','sha256',input.blob.hash.slice(7,9),input.blob.hash.slice(7)))),input.blob.hash);
  if(['reviewer-valid-unknown-icc-before.png','reviewer-valid-unknown-icc-after.png','reviewer-orientation-6-after.png'].includes(item.name)){
   for(const body of [{type:'ReviewRaster',assetId:input.id},{type:'ApproveRaster',assetId:input.id,reviewId:randomUUID(),reviewHash:'sha256:'+'0'.repeat(64)},{type:'ExportRaster',assetId:input.id}])assert.equal((await terminal(f,envelope(f,body))).json.receipt.status,'rejected');
  }
  const reused={...c,command:{...c.command,body:{type:'PrepareRaster',assetId:'different-original'}}};
  assert.equal((await f.post('/api/v1/commands',reused)).json.error.code,'COMMAND_ID_REUSE');
  retries.push({c,r});
 });
 const cookie=cookieFrom(f.paired);await f.server.close();const server=await startLocalServer({root:f.root});t.after(()=>server.close());
 const paired=await call(server.origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:server.origin,Cookie:cookie},body:{protocolVersion:1,pairingToken:new URL(server.issuePairingURL()).hash.slice(9)}});
 for(const {c,r} of retries){const again=await call(server.origin,'/api/v1/commands',{method:'POST',body:c,headers:mutationHeaders(server,paired)});assert.deepEqual(again.json.receipt,r.json.receipt);}
});
test('supported ICC and valid orientation remain explicit through review, approval and export',async t=>{
 const f=await setup(t);
 for(const name of ['p3-color.png','orientation-6.png']){
  const input=await original(f,name),prepared=await operate(f,{type:'PrepareRaster',assetId:input.id}),preview=prepared.event.payload.asset;
  const r=await operate(f,{type:'ReviewRaster',assetId:preview.id}),review=(await f.read('/api/v1/assets/raster-reviews/'+r.event.payload.reviewId)).json;
  if(name==='p3-color.png'){assert.equal(review.conversion.profile,'p3');assert.equal(review.conversion.colorChanged,true);assert.ok(review.conversion.profileHash);}
  else{assert.equal(review.conversion.orientation,6);assert.equal(review.conversion.orientationChanged,true);assert.equal(preview.raster.width,2);assert.equal(preview.raster.height,3);}
  const accepted=(await operate(f,{type:'ApproveRaster',assetId:preview.id,reviewId:review.reviewId,reviewHash:review.reviewHash})).event.payload.asset;
  const exported=(await operate(f,{type:'ExportRaster',assetId:accepted.id})).event.payload.asset;
  assert.deepEqual(accepted.raster,preview.raster);assert.equal(exported.raster.pixelIdentity,preview.raster.pixelIdentity);
  assert.deepEqual((await binary(f,exported.id)).bytes,(await binary(f,preview.id)).bytes);
 }
});
test('valid PNG depths, palette transparency, split streams, metadata and Adam7 retain independent pixels',async t=>{
 const f=await setup(t);
 for(const item of manifest.fixtures.filter(x=>x.valid))await t.test(item.name,async()=>{
  const input=await original(f,'../png-validation/'+item.name),prepared=await operate(f,{type:'PrepareRaster',assetId:input.id});
  const response=await binary(f,prepared.event.payload.asset.id);assert.equal(response.status,200);
  const pixels=await sharp(response.bytes,{ignoreIcc:true}).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...pixels],item.expectedRGBA);assert.equal(prepared.event.payload.asset.raster.width,item.width);assert.equal(prepared.event.payload.asset.raster.height,item.height);
 });
});

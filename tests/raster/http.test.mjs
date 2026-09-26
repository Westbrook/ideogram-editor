import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
import {setup,pair,call,cookieFrom,readHeaders,mutationHeaders} from '../protocol/helpers.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {canonical} from '../../dist/local/server/storage/canonical.js';
import {original,operate,importRaster,binary,layer,envelope,terminal,digest} from './helpers.mjs';
const rgba=async response=>{assert.equal(response.status,200,response.bytes.toString());return sharp(response.bytes,{ignoreIcc:true}).ensureAlpha().raw().toBuffer();};
test('real original → worker → durable preview → exact review approval → CP-1 capture → PNG export and reopen',async t=>{
 const f=await setup(t);const white=await importRaster(f,'white.png'),black=await importRaster(f,'black.png');
 assert.equal((await f.read('/api/v1/assets/'+white.input.id+'/content')).status,403);
 assert.equal(white.preview.qualification,'raster-preview');assert.equal(white.asset.qualification,'canonical-raster');assert.deepEqual(white.asset.raster,white.preview.raster);assert.deepEqual(white.asset.blob,white.preview.blob);
 const k=await operate(f,{type:'ComposeRaster',width:1,height:1,layers:[layer(white.asset.id,{opacity:.1})]});assert.deepEqual([...(await rgba(await binary(f,k.event.payload.asset.id)))],[255,255,255,26]);
 const stack=await operate(f,{type:'ComposeRaster',width:1,height:1,layers:[layer(black.asset.id),layer(white.asset.id,{opacity:.1})]});const a=stack.event.payload.asset;
 assert.deepEqual([...(await rgba(await binary(f,a.id)))],[90,90,90,255]);
 const replaced=await operate(f,{type:'ComposeRaster',width:1,height:1,layers:[layer(black.asset.id),layer(k.event.payload.asset.id)]});assert.equal(replaced.event.payload.asset.raster.pixelIdentity,a.raster.pixelIdentity);
 const exported=await operate(f,{type:'ExportRaster',assetId:a.id});assert.equal(exported.event.payload.asset.raster.pixelIdentity,a.raster.pixelIdentity);assert.deepEqual(await rgba(await binary(f,exported.event.payload.asset.id)),Buffer.from([90,90,90,255]));
 const manifest=await f.read('/api/v1/assets/'+a.id+'/raster');assert.equal(manifest.status,200,manifest.text);assert.equal(manifest.json.pixels.hash,a.raster.pixels.hash);assert.equal(manifest.json.plan.layers[1].opacity,.1);
 const full=await binary(f,a.id);assert.equal(full.headers['content-type'],'image/png');assert.match(full.headers['content-security-policy'],/sandbox/);assert.deepEqual((await binary(f,a.id,{Range:'bytes=0-7'})).bytes,full.bytes.subarray(0,8));
 assert.equal((await f.read('/api/v1/assets/'+a.raster.pixels.hash.slice(7)+'/content')).status,404);
 const cookie=cookieFrom(f.paired);await f.server.close();const server=await startLocalServer({root:f.root});t.after(()=>server.close());const paired=await call(server.origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:server.origin,Cookie:cookie},body:{protocolVersion:1,pairingToken:new URL(server.issuePairingURL()).hash.slice(9)}});
 const g={server,paired};assert.deepEqual((await binary(g,exported.event.payload.asset.id)).bytes,(await readFile(join(f.root,'objects','sha256',exported.event.payload.asset.blob.hash.slice(7,9),exported.event.payload.asset.blob.hash.slice(7)))));
 assert.deepEqual(await rgba(await binary(g,exported.event.payload.asset.id)),Buffer.from([90,90,90,255]));
 const retry=await call(server.origin,'/api/v1/commands',{method:'POST',body:exported.command,headers:mutationHeaders(server,paired)});assert.deepEqual(retry.json.receipt,exported.receipt);
});
test('hidden RGB identity, exact mask coordinates, empty output, cache dependencies and lossless JPEG-source export',async t=>{
 const f=await setup(t),hidden=await importRaster(f,'hidden-alpha.png');const expected=Buffer.from([17,99,231,0,255,0,0,128,0,255,0,255,0,0,255,64,255,255,255,255,0,0,0,255]);
 const identity=await operate(f,{type:'ComposeRaster',width:3,height:2,layers:[layer(hidden.asset.id)]});assert.deepEqual(await rgba(await binary(f,identity.event.payload.asset.id)),expected);
 const moved=await operate(f,{type:'ComposeRaster',width:3,height:2,layers:[layer(hidden.asset.id,{transform:[1,0,0,1,.5,0]})]});assert.notEqual(moved.event.payload.asset.raster.manifest.hash,identity.event.payload.asset.raster.manifest.hash);assert.notEqual(moved.event.payload.asset.raster.pixelIdentity,identity.event.payload.asset.raster.pixelIdentity);
 const again=await operate(f,{type:'ComposeRaster',width:3,height:2,layers:[layer(hidden.asset.id)]});assert.equal(again.event.payload.asset.raster.manifest.hash,identity.event.payload.asset.raster.manifest.hash);
 const empty=await operate(f,{type:'ComposeRaster',width:3,height:2,layers:[]});assert.deepEqual(await rgba(await binary(f,empty.event.payload.asset.id)),Buffer.alloc(24));
 const mask=await importRaster(f,'mask.png');const masked=await operate(f,{type:'ComposeRaster',width:3,height:2,layers:[layer(hidden.asset.id,{mask:{assetId:mask.asset.id,mapping:'document-luminance-alpha-v1',inverted:false}})]});assert.deepEqual([...(await rgba(await binary(f,masked.event.payload.asset.id)))],[0,0,0,0,255,0,0,128,0,255,0,128,0,0,0,0,255,255,255,255,0,0,0,0]);
 const jpg=await importRaster(f,'white.jpg'),exported=await operate(f,{type:'ExportRaster',assetId:jpg.asset.id});assert.deepEqual(await rgba(await binary(f,exported.event.payload.asset.id)),Buffer.alloc(16*16*4,255));
 const bad=await terminal(f,envelope(f,{type:'ComposeRaster',width:2,height:2,layers:[layer(hidden.asset.id,{mask:{assetId:mask.asset.id,mapping:'document-luminance-alpha-v1',inverted:false}})]}));assert.equal(bad.json.receipt.status,'rejected');
});
test('conversion review binds actual decoded preview, exact hash, owner, session and writer epoch',async t=>{
 let now=Date.now();const f=await setup(t,{now:()=>now});const input=await original(f,'p3.png'),prepared=await operate(f,{type:'PrepareRaster',assetId:input.id}),preview=prepared.event.payload.asset;
 assert.equal(preview.raster.conversion.colorChanged,true);assert.equal((await binary(f,preview.id)).status,200);
 const unapproved=await terminal(f,envelope(f,{type:'ComposeRaster',width:3,height:2,layers:[layer(preview.id)]}));assert.equal(unapproved.json.receipt.code,'INCOMPATIBLE');
 const preparedReview=await operate(f,{type:'ReviewRaster',assetId:preview.id});const review=(await f.read('/api/v1/assets/raster-reviews/'+preparedReview.event.payload.reviewId)).json;
 const {reviewHash,...value}=review;assert.equal(digest(canonical(value)),reviewHash);assert.equal(review.previewAssetId,preview.id);
 const wrong=await terminal(f,envelope(f,{type:'ApproveRaster',assetId:preview.id,reviewId:review.reviewId,reviewHash:'sha256:'+'0'.repeat(64)}));assert.equal(wrong.json.receipt.code,'STALE_REVISION');
 const foreign=await pair(f.server);assert.equal((await call(f.server.origin,'/api/v1/assets/raster-reviews/'+review.reviewId,{headers:readHeaders(cookieFrom(foreign))})).status,403);
 f.paired=await f.post('/api/v1/session/renew',{protocolVersion:1});assert.equal((await f.read('/api/v1/assets/raster-reviews/'+review.reviewId)).status,410);
 const stale=await terminal(f,envelope(f,{type:'ApproveRaster',assetId:preview.id,reviewId:review.reviewId,reviewHash}));assert.equal(stale.json.receipt.code,'INVALID_INPUT');
});
test('malformed, animated and unsupported-profile originals retain bytes and terminal diagnostics without usable asset',async t=>{
 const f=await setup(t);for(const name of ['truncated.png','truncated.jpg','truncated.webp','animated.webp','animated-marker.png','unknown-profile.png','bad-crc.png','oversize.png']){
  const input=await original(f,name),c=envelope(f,{type:'PrepareRaster',assetId:input.id}),r=await terminal(f,c);assert.equal(r.json.receipt.status,'rejected',name);assert.equal(r.json.receipt.code,'INVALID_INPUT');assert.deepEqual((await f.post('/api/v1/commands',c)).json,r.json);
  assert.equal((await f.read('/api/v1/assets/'+input.id+'/content')).status,403);assert.equal(digest(await readFile(join(f.root,'objects','sha256',input.blob.hash.slice(7,9),input.blob.hash.slice(7)))),input.blob.hash);
 }
});

test('real worker reconstruction crosses128/512 tile boundaries with independent expected pixels',async t=>{
 const f=await setup(t),image=await importRaster(f,'seam-checker.png');
 const shifted=await operate(f,{type:'ComposeRaster',width:520,height:2,layers:[layer(image.asset.id,{transform:[1,0,0,1,.5,0]})]});const out=await rgba(await binary(f,shifted.event.payload.asset.id));
 for(let y=0;y<2;y++)for(let x=1;x<520;x++)assert.deepEqual([...out.subarray((y*520+x)*4,(y*520+x)*4+4)],[188,0,188,255]);
 const reduced=await operate(f,{type:'ComposeRaster',width:260,height:2,layers:[layer(image.asset.id,{transform:[.5,0,0,1,0,0]})]});const down=await rgba(await binary(f,reduced.event.payload.asset.id));
 for(let y=0;y<2;y++)for(let x=1;x<259;x++)assert.deepEqual([...down.subarray((y*260+x)*4,(y*260+x)*4+4)],[188,0,188,255]);
 const manifest=(await f.read('/api/v1/assets/'+shifted.event.payload.asset.id+'/raster')).json;assert.equal(manifest.tiles.length,2);assert.equal(manifest.tiles[1].x,512);assert.equal(manifest.plan.edge,'transparent-zero-no-renormalization');
});

test('actual concurrent foundation and raster requests cannot reuse one durable command ID',async t=>{
 const f=await setup(t),a=await original(f,'white.png');
 for(let i=0;i<12;i++){
  const raster=envelope(f,{type:'PrepareRaster',assetId:a.id});
  const foundation={...raster,command:{...raster.command,documentId:'race-'+i,body:{type:'NewDocument',width:1,height:1,color:'sRGB',depth:8}}};
  const replies=await Promise.all([f.post('/api/v1/commands',raster),f.post('/api/v1/commands',foundation)]);
  assert.equal(replies.filter(r=>r.status===409&&r.json.error.code==='COMMAND_ID_REUSE').length,1);
  const winner=replies[0].status===409?foundation:raster;const final=await terminal(f,winner);assert.equal(final.json.receipt.status,'accepted');
  const retry=await f.post('/api/v1/commands',winner);assert.equal(retry.status,200);assert.deepEqual(retry.json.receipt,final.json.receipt);
 }
});

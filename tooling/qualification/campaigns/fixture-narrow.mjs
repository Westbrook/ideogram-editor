// Separate PERF-8+A3 8192x3000 encoded import specimen. No large-history claim.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { auth, createDocument, envelope, finish, product } from './backend-common.mjs';
import { fileIdentity } from './fixtures.mjs';

export function planNarrowFixture({definition,corpus}) {
  if(definition?.id!=='WNarrow'||definition.width!==8192||definition.height!==3000||definition.layers!==1||definition.visibleLayers!==1)throw Error('WNarrow requires exactly8192x3000 and one visible layer');
  const files=corpus?.files?.filter(file=>file.role==='raster-original');
  if(files?.length!==1)throw Error('WNarrow needs one independently owned original');
  const original=files[0];
  if(!isAbsolute(original.path)||!/^sha256:[a-f0-9]{64}$/.test(original.sha256)||!/^[1-9][0-9]*$/.test(original.byteLength)||BigInt(original.byteLength)>32n*1048576n||original.width!==8192||original.height!==3000||!['png','jpeg','webp'].includes(original.format))throw Error('WNarrow original identity, dimensions, format or byte bound is invalid');
  return {original,width:8192,height:3000,scope:'one real encoded import and visible layer; ordinary initialization history is retained, without a10k/100k history cohort'};
}
const assetFrom=result=>{const asset=result.events.find(event=>event.payload?.asset)?.payload.asset;if(!asset)throw Error('Expected actual durable asset registration');return asset;};

export async function rasterFixture({repo,root,definition,corpus,signal,onProgress=()=>{}}) {
  const plan=planNarrowFixture({definition,corpus}),originalIdentity=await fileIdentity(plan.original.path);
  assert.deepEqual(originalIdentity,{sha256:plan.original.sha256,byteLength:plan.original.byteLength});
  if(!isAbsolute(root)||await realpath(dirname(root))!==dirname(root))throw Error('WNarrow needs a new canonical private root');
  await mkdir(root,{mode:0o700});
  const context={repo:resolve(repo),signal}, {openWriter}=await product(context,'server/storage/writer.js');
  const testing=globalThis.__storeNetworkCounters?.shared?{effectCounters:globalThis.__storeNetworkCounters.shared}:undefined;
  let writer=await openWriter({root},testing);const documentId='qualification_wnarrow',layerId='narrow_picture',receipts=[];
  async function prepareWriter(){await writer.rememberClient(auth().sessionHash,'client_1',auth().expires);await writer.protocolDefaults();}
  async function command(body,method,scoped=false){signal?.throwIfAborted();const request=envelope(body,scoped?{documentId,expectedDocumentRevision:await writer.documentRevision(documentId)}:{}),result=await finish(writer,request,method,signal);receipts.push(result.receipt);await onProgress({phase:'narrow-product-command',type:body.type,receipt:result.receipt});return result;}
  async function proveAsset(id){const proof=await writer.assetVerify(id);try{return proof.asset;}finally{await writer.assetRelease(proof.handle);}}
  try {
    await prepareWriter();await createDocument({writer,documentId,context},{width:8192,height:3000});
    const stagingId=randomUUID(),mediaType='image/'+plan.original.format;await writer.assetCreate({protocolVersion:1,stagingId,purpose:'image',expectedBytes:plan.original.byteLength,sha256:plan.original.sha256,mediaType},auth());
    let offset=0;const consumed=createHash('sha256');
    for await(const chunk of createReadStream(plan.original.path,{highWaterMark:65536})){signal?.throwIfAborted();const token=await writer.assetBeginChunk(stagingId,String(offset),chunk.length,auth());await writer.assetChunk(token,chunk,auth());offset+=chunk.length;consumed.update(chunk);}
    assert.equal(String(offset),plan.original.byteLength);assert.equal('sha256:'+consumed.digest('hex'),plan.original.sha256);
    const original=assetFrom(await command({type:'FinalizeStaging',stagingId,expectedSha256:plan.original.sha256},'assetCommand'));
    const preview=assetFrom(await command({type:'PrepareRaster',assetId:original.id},'rasterCommand'));
    const prepared=await command({type:'ReviewRaster',assetId:preview.id},'rasterCommand'),reviewEvent=prepared.events.find(event=>event.type==='RasterReviewPrepared');assert(reviewEvent);
    const review=await writer.rasterReview(reviewEvent.payload.reviewId,auth());
    const raster=assetFrom(await command({type:'ApproveRaster',assetId:preview.id,reviewId:review.reviewId,reviewHash:review.reviewHash},'rasterCommand'));
    assert.equal(raster.raster.width,8192);assert.equal(raster.raster.height,3000);
    await command({type:'ImportAsset',assetId:raster.id,layerId,name:'8192 by3000 narrow fixture',draft:null},'historyCommand',true);
    const before={document:await writer.document(documentId),state:await writer.imageState(documentId)};
    assert.equal(before.state.layers.length,1);assert.equal(before.state.layers[0].visible,true);assert.equal(before.state.layers[0].assetId,raster.id);
    await writer.close();writer=await openWriter({root},testing);await prepareWriter();
    const after={document:await writer.document(documentId),state:await writer.imageState(documentId)};assert.deepEqual(after,before);
    assert.equal((await proveAsset(original.id)).blob.hash,plan.original.sha256);assert.equal((await proveAsset(raster.id)).raster.pixels.hash,raster.raster.pixels.hash);const pixels=raster.raster.pixels;assert.match(pixels.hash,/^sha256:[a-f0-9]{64}$/);assert.deepEqual(await fileIdentity(join(root,'objects','sha256',pixels.hash.slice(7,9),pixels.hash.slice(7))),{sha256:pixels.hash,byteLength:pixels.byteLength});
    const capture=await writer.capture(),closure=[];let next='';do{const page=await writer.historyClosure(documentId,next);closure.push(...page.items);next=page.next??page.nextCursor??'';}while(next);
    assert(closure.some(ref=>ref.hash===original.blob.hash),'Original remains in the retained document closure');
    assert(closure.some(ref=>ref.hash===raster.raster.pixels.hash),'Canonical raster pixels remain in the document closure');
    const observed={productionValidated:true,width:8192,height:3000,layers:1,imageLayers:1,textLayers:0,visibleLayers:1,activeRequests:0,candidates:0,queued:0,events:Number(capture.highWater),storeEvents:Number(capture.highWater),snapshotTail:capture.snapshot?Number(BigInt(capture.highWater)-BigInt(capture.snapshot.seq)):0,originalRetained:true,canonicalRasterReady:true,restartVerified:true};
    return {kind:'narrow-product-fixture',schemaVersion:1,root,documentId,layerIds:[layerId],originalAssetIds:[original.id],rasterAssetIds:[raster.id],raster:{assetId:raster.id,pixels:raster.raster.pixels,width:8192,height:3000,originalAssetId:original.id,original:original.blob},observed,receipts,scope:plan.scope};
  }finally{await writer.close();}
}

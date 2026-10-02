import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {rootFor,command,pair,call,cookieFrom,readHeaders,mutationHeaders} from '../protocol/helpers.mjs';
import {importRaster,operate,terminal} from '../raster/helpers.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
import {bindRequestMask,confirmRequestMask} from '../../dist/local/src/request/core.js';
import {canonical,hashBytes} from '../../dist/local/server/storage/canonical.js';
import {validateV45InputsClosure,verifyV45InputsComputation,v45InputsAssetIds} from '../../dist/local/server/portable/v45-inputs.js';

const doc=async f=>(await f.read('/api/v1/documents/document_1')).json.projection.value;
const objectPath=(root,ref)=>join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
async function edit(f,body){
  const result=await terminal(f,f.command({expectedDocumentRevision:(await doc(f)).revision,body}));assert.equal(result.json.receipt.status,'accepted',result.text);
  const page=await f.read('/api/v1/events?after='+String(BigInt(result.json.receipt.fromSeq)-1n));assert.equal(page.json.batches[0].kind,'inline');
  return page.json.batches[0].events;
}
async function capture(f,scope,layerIds){
  const before=await doc(f),events=await edit(f,{type:'PrepareRequestSource',scope,layerIds}),asset=events[0].payload.asset;
  return {assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster.pixels,width:asset.raster.width,height:asset.raster.height,scope,documentRevision:before.revision,capture:asset.raster.manifest};
}
async function fixture(t){
  let server;t.after(()=>server?.close());const root=await rootFor(t);server=await startLocalServer({root});
  const paired=await pair(server);assert.equal(paired.status,200,paired.text);
  const f={root,server,paired,read:path=>call(server.origin,path,{headers:readHeaders(cookieFrom(paired))}),post:(path,body)=>call(server.origin,path,{method:'POST',body,headers:mutationHeaders(server,paired)}),command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body)};
  assert.equal((await terminal(f,f.command({}, {width:3,height:2}))).json.receipt.status,'accepted');
  for(const [id,name] of [['picture','hidden-alpha.png'],['overlay','white.png']]){const {asset}=await importRaster(f,name);await edit(f,{type:'ImportAsset',assetId:asset.id,layerId:id,name:id,draft:null});}
  const source=await capture(f,'single-layer',['picture']),reference=await capture(f,'visible-document',[]);
  const maskAsset=(await operate(f,{type:'PrepareRequestMask',sourceAssetId:source.assetId,plan:{width:3,height:2,feather:0,operations:[{kind:'shape',shape:{kind:'rectangle',x:1,y:0,width:1,height:1},mode:'replace'}]},clip:null})).event.payload.asset;
  const maskManifest=(await f.read('/api/v1/assets/'+maskAsset.id+'/raster')).json;
  const mask={assetId:maskAsset.id,version:maskAsset.version,blob:maskAsset.blob,pixels:maskAsset.raster.pixels,width:3,height:2,sourceHash:source.pixels.hash,polarity:'white-edit',fullAcknowledged:false,empty:false,full:false,plan:maskAsset.raster.manifest,binding:bindRequestMask(source)};
  mask.requestPlan=confirmRequestMask(source,mask,maskManifest.plan.hard,maskManifest.plan.effective,randomUUID());
  const owner=(await operate(f,{type:'PrepareV45EditInputs',source,mask,references:[reference]})).event.payload.asset;
  const manifest=(await f.read('/api/v1/assets/'+owner.id+'/raster')).json,assets=new Map();
  for(const id of v45InputsAssetIds(manifest.plan))assets.set(id,(await f.read('/api/v1/assets/'+id)).json.projection.value);
  return {f,owner,manifest,assets,read:ref=>readFile(objectPath(root,ref))};
}
function view(seed){
  const overlays=new Map(),assets=new Map([...seed.assets].map(([id,asset])=>[id,structuredClone(asset)]));
  const write=value=>{const bytes=Buffer.from(canonical(value)),ref={hash:hashBytes(bytes),byteLength:String(bytes.length),mediaType:'application/json'};overlays.set(ref.hash,bytes);return ref;};
  const read=async ref=>overlays.get(ref.hash)??seed.read(ref);
  const value={owner:structuredClone(seed.owner),manifest:structuredClone(seed.manifest),assets,read,write};
  value.seal=()=>{const old=value.owner.raster.manifest,ref=write(value.manifest);value.owner.raster.manifest=ref;value.owner.dependencies=value.owner.dependencies.map(dependency=>canonical(dependency)===canonical(old)?ref:dependency);};
  return value;
}
async function validate(value){
  const needed=[];const closure=await validateV45InputsClosure(value.manifest,value.read,ref=>needed.push(ref),{owner:value.owner,asset:id=>value.assets.get(id)});
  return {closure,needed};
}
const pixelIdentity=manifest=>hashBytes(canonical({pipeline:manifest.pipeline,width:manifest.width,height:manifest.height,tiles:manifest.tiles}));
async function replayContext(seed,value,corrupt=null){
  const plan=seed.manifest.plan,calls=[];
  const result=async(ref,encoded,phase)=>{
    const manifest=JSON.parse(await seed.read(ref)),value={manifest,png:encoded,info:{manifest:ref,width:manifest.width,height:manifest.height,pipeline:manifest.pipeline,pixels:manifest.pixels,pixelIdentity:pixelIdentity(manifest)}};
    if(phase===corrupt)value.info.pixelIdentity='sha256:'+'0'.repeat(64);return value;
  };
  const context={asset:value.owner,directory:seed.f.root,slot:'portable-fixture',path:ref=>objectPath(seed.f.root,ref),
    input:async id=>{const asset=value.assets.get(id);assert(asset);return {id,info:asset.raster,path:objectPath(seed.f.root,asset.raster.pixels)};},
    rasters:{
      validateV45EditSourcePortable:async(source,requestPlan,directory,slot,check,replay)=>{
        check();calls.push({phase:requestPlan?'source':'reference',source,requestPlan,directory,slot,replay});
        const reference=plan.references.find(item=>item.original.assetId===source.id);
        return requestPlan?result(plan.input,seed.owner.blob,'source'):result(reference.input.manifest,reference.input.blob,'reference');
      },
      validateV45EditMaskPortable:async(requestPlan,sourceManifest,sourcePixels,mask,directory,slot,check,replay)=>{
        check();calls.push({phase:'mask',requestPlan,sourceManifest,sourcePixels,mask,directory,slot,replay});return result(plan.mask.manifest,plan.mask.blob,'mask');
      },
    },
  };
  return {context,calls};
}

test('V45 portable prepared inputs bind originals, local aliases, exact R16 and every recomputation result',async t=>{
  const seed=await fixture(t);
  await t.test('real prepared root contains black-edit mask and reference closure',async()=>{
    const value=view(seed),{closure,needed}=await validate(value),plan=closure.plan;
    assert.equal(closure.blackMask.plan.polarity,'black-edit');assert.equal(plan.mask.editPixels,1);assert.equal(plan.mask.keepPixels,5);
    assert.equal(closure.references.length,1);assert.deepEqual(closure.workerInput.pixels,seed.owner.raster.pixels);
    for(const ref of [plan.input,plan.original.source.capture,plan.original.mask.plan,plan.mask.manifest,plan.mask.pixels,plan.references[0].input.manifest,plan.references[0].input.blob,plan.requestPlan.authoredMask,plan.requestPlan.effectiveMask])assert(needed.some(value=>canonical(value)===canonical(ref)),ref.hash);
    assert(closure.metadata.some(ref=>ref.hash===plan.original.source.capture.hash));
  });
  await t.test('local aliases change only explicit bindings and replay uses frozen original identities',async()=>{
    const value=view(seed),original=canonical(value.manifest.plan.original),refs=canonical(value.manifest.plan.references);
    const names=['copied_source','copied_mask','copied_reference'],old=v45InputsAssetIds(value.manifest.plan);
    value.assets=new Map(old.map((id,index)=>[names[index],{...value.assets.get(id),id:names[index]}]));
    value.manifest.plan.assetBindings={source:names[0],mask:names[1],references:[names[2]]};value.owner.raster.sourceAssetIds=names;value.seal();
    const {closure}=await validate(value),{context,calls}=await replayContext(seed,value);await verifyV45InputsComputation(closure,context);
    assert.deepEqual(calls.map(call=>call.phase),['source','mask','reference']);assert.equal(canonical(closure.plan.original),original);assert.equal(canonical(closure.plan.references),refs);
    assert.equal(calls[0].source.id,seed.manifest.plan.original.source.assetId);assert.deepEqual(calls[0].source.info.manifest,seed.manifest.plan.original.source.capture);
    assert.equal(calls[1].mask.id,seed.manifest.plan.original.mask.assetId);assert.equal(calls[1].mask.coveragePath,objectPath(seed.f.root,seed.manifest.plan.requestPlan.effectiveMask));
    assert.deepEqual(calls[1].sourceManifest,seed.manifest.plan.original.source.capture);assert.deepEqual(calls[1].sourcePixels,seed.manifest.pixels);
    assert.equal(calls[2].source.id,seed.manifest.plan.references[0].original.assetId);
  });
  await t.test('binding a different rendered source is rejected',async()=>{
    const value=view(seed);value.manifest.plan.assetBindings.source=value.manifest.plan.assetBindings.references[0];value.owner.raster.sourceAssetIds=v45InputsAssetIds(value.manifest.plan);value.seal();
    await assert.rejects(validate(value));
  });
  await t.test('wrapper tile identities cannot diverge from the retained source worker',async()=>{
    const value=view(seed);value.manifest.tiles[0].hash='sha256:'+'0'.repeat(64);value.owner.raster.pixelIdentity=pixelIdentity(value.manifest);value.seal();
    await assert.rejects(validate(value));
  });
  await t.test('identical rounded mask pixels do not permit a different local effective R16 object',async()=>{
    const value=view(seed),id=value.manifest.plan.assetBindings.mask,asset=value.assets.get(id),current=JSON.parse(await value.read(asset.raster.manifest));
    const different={...current.plan.effective,hash:'sha256:'+'0'.repeat(64)};current.plan.effective=different;current.dependencies=[...current.dependencies,different];
    asset.raster.manifest=value.write(current);
    // RGBA8, encoded PNG, dimensions, version and pixel identity are unchanged.
    assert.deepEqual(asset.raster.pixels,seed.assets.get(id).raster.pixels);assert.deepEqual(asset.blob,seed.assets.get(id).blob);
    await assert.rejects(validate(value));
  });
  for(const phase of ['source','mask','reference'])await t.test('reject mismatched '+phase+' recomputation identity',async()=>{
    const value=view(seed),{closure}=await validate(value),{context,calls}=await replayContext(seed,value,phase);
    await assert.rejects(verifyV45InputsComputation(closure,context));assert.equal(calls.at(-1).phase,phase);
  });
});

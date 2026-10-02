import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {adapterResources} from '../../dist/local/server/observability/adapter-resources.js';
import {AssetRoutes} from '../../dist/local/server/assets.js';
import {assetProjectionSchema,validateAssetProjection} from '../../dist/local/src/protocol/asset-projection.js';

const hash=character=>'sha256:'+character.repeat(64);
const ref=(character,mediaType,byteLength='4')=>({hash:hash(character),mediaType,byteLength});
const original=()=>({id:'original',version:'1',purpose:'image',blob:ref('a','image/png'),dependencies:[],safety:'unknown',availability:'available',qualification:'pending-decoder',measuredMediaType:'image/png'});
function raster(role='composite',qualification='canonical-raster'){
  const manifest=ref('b','application/json'),pixels=ref('c','application/x-ideogram-rgba8');
  return {...original(),id:'asset_'+role,safety:'safe',qualification,dependencies:[manifest,pixels],raster:{schemaVersion:role==='mask'?2:1,pipeline:'cp1-f64-triangle-area-v1/'+hash('d'),width:1,height:1,manifest,pixels,pixelIdentity:hash('e'),role,sourceAssetIds:role==='derived'?['original']:[],conversion:role==='native'?{encodedWidth:1,encodedHeight:1,orientation:1,profile:'untagged-srgb',profileHash:null,colorChanged:false,orientationChanged:false,resized:false}:null}};
}
const envelope=(asset,projectionSchema=asset.raster?.role==='derived'?3:2)=>({protocolVersion:1,entityVersion:asset.version,projectionSchema,highWater:'12',projection:{kind:'inline',value:asset}});

test('asset projection2 preserves legacy asset semantics;3 identifies derived preview and approved raster',()=>{
  for(const asset of [original(),raster(),raster('native'),raster('native','raster-preview'),raster('mask'),raster('export','canonical-png')]){
    const before=JSON.stringify(asset);assert.equal(assetProjectionSchema(asset),2);assert.equal(validateAssetProjection(envelope(asset)),asset);assert.equal(JSON.stringify(asset),before);
  }
  for(const qualification of ['raster-preview','canonical-raster']){
    const asset=raster('derived',qualification),before=JSON.stringify(asset);assert.equal(assetProjectionSchema(asset),3);assert.equal(validateAssetProjection(envelope(asset)),asset);assert.equal(JSON.stringify(asset),before);
    assert.throws(()=>validateAssetProjection(envelope(asset,2)));
  }
  assert.throws(()=>validateAssetProjection(envelope(raster(),3)));
});

test('asset projection rejects future, mismatched, malformed and extra direct metadata before returning an asset',()=>{
  const changes=[
    value=>value.projectionSchema=4,value=>value.projectionSchema=9,value=>value.projectionSchema='3',value=>delete value.projectionSchema,
    value=>value.protocolVersion=2,value=>value.entityVersion='2',value=>value.entityVersion=1,value=>value.highWater='01',value=>value.highWater=-1,
    value=>value.extra=true,value=>value.projection.extra=true,value=>value.projection.kind='content-ref',
    value=>value.projection.value.extra=true,value=>value.projection.value.id='../asset',value=>value.projection.value.safety='approved',
    value=>value.projection.value.raster.role='future-derived',value=>value.projection.value.raster.pixels.byteLength='8',
    value=>value.projection.value.dependencies=[],value=>value.projection.value.raster.pipeline='unqualified',
  ];
  for(const change of changes){const value=envelope(raster('derived'));change(value);assert.throws(()=>validateAssetProjection(value));}
  for(const value of [null,[],{},true])assert.throws(()=>validateAssetProjection(value));
});

// A route may finish before the HTTP reply does. Hold the actual end callback
// and emit the terminal event so the production reply owner remains testable.
class HeldResponse extends EventEmitter {
  destroyed=false;closed=false;writableEnded=false;writableFinished=false;done;
  writeHead(code,headers){this.status=code;this.headers=headers;return this;}
  end(bytes,done){assert.equal(typeof done,'function');this.writableEnded=true;this.byteLength=bytes.length;this.body=JSON.parse(bytes.toString());this.done=done;return this;}
  finish(){const done=this.done;this.done=undefined;this.writableFinished=true;this.emit('finish');done?.();}
  close(){this.destroyed=true;this.closed=true;this.done=undefined;this.emit('close');}
}
const responseBuffers=()=>adapterResources.snapshot().groups.find(group=>group.owner==='protocol-response'&&group.kind==='json-bytes')?.buffers??0;

test('asset view route emits matching separate schema and refuses invalid assets before writing headers',async()=>{
  for(const asset of [original(),raster(),raster('derived','raster-preview'),raster('derived')]){
    let authentications=0;
    const routes=new AssetRoutes({assetProjection:async id=>{assert.equal(id,asset.id);return {asset,highWater:'12'};}},()=>0);
    const response=new HeldResponse(),baseline=adapterResources.snapshot(),buffers=responseBuffers();
    try{
      await routes.handle({method:'GET'},response,routes.match('/api/v1/assets/'+asset.id),new URLSearchParams(),()=>{authentications++;return {};},async()=>assert.fail('read route must not mutate roots'));
      assert.equal(response.status,200);assert.match(response.headers['Content-Type'],/^application\/json/);assert.equal(response.headers['Content-Length'],response.byteLength);
      assert.equal(authentications,1);assert.deepEqual(response.body,envelope(asset));assert.deepEqual(validateAssetProjection(response.body),asset);
      assert.equal(response.writableEnded,true);assert.equal(response.writableFinished,false);
      assert.equal(responseBuffers(),buffers+1);assert.equal(adapterResources.snapshot().activeLeases,baseline.activeLeases+1);
      response.finish();
      assert.equal(response.writableFinished,true);assert.equal(response.done,undefined);assert.equal(responseBuffers(),buffers);
      for(const event of ['finish','close','error'])assert.equal(response.listenerCount(event),0);
      const after=adapterResources.snapshot();
      for(const key of ['cpuBytes','backingStores','activeLeases','returnedBuffers','droppedTransitions','unscopedReturnedBuffers'])assert.equal(after[key],baseline[key],key);
      assert.equal(after.aggregate.currentCpuBytes,baseline.aggregate.currentCpuBytes);
    }finally{response.close();}
  }
  const invalid=raster('future-derived');let writes=0;
  const routes=new AssetRoutes({assetProjection:async()=>({asset:invalid,highWater:'12'})},()=>0);
  await assert.rejects(()=>routes.handle({method:'GET'},{writeHead(){writes++;},end(){writes++;}},routes.match('/api/v1/assets/'+invalid.id),new URLSearchParams(),()=>({}),async()=>{}));
  assert.equal(writes,0);
});

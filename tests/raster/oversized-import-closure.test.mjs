import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDerivedImportEdge,verifyDerivedImportReplay} from '../../dist/local/server/portable/imports.js';
const hash=n=>'sha256:'+String(n).repeat(64),blob=(n,type='application/json')=>({hash:hash(n),byteLength:'100',mediaType:type});
function fixture(){
 const original=blob(1,'image/png'),pixels=blob(2,'application/x-ideogram-rgba8'),source={id:'sourceA',version:'1',purpose:'image',blob:original,dependencies:[],safety:'unknown',availability:'available',qualification:'pending-decoder',measuredMediaType:'image/png'};
 const plan={kind:'decoded-derived-v1',sourceAssetId:'sourceA',original,inspectionHash:hash(3),encoded:{width:8193,height:1},orientation:1,profile:'untagged-srgb',profileHash:null,operation:{kind:'crop',x:8191,y:0,width:2,height:1},kernel:'triangle-area-source-axis-row-norm-v1',codec:hash(4),decodeTransport:'png-scanline-file-cp1-v1',decoderSource:hash(5)};
 const manifest={schemaVersion:1,pipeline:'test-only-unissued',width:2,height:1,format:'straight-srgb-rgba8',layout:'row-major-tile-views-v1',tileSize:512,pixels,tiles:[],dependencies:[original],plan};
 const raster={schemaVersion:1,pipeline:manifest.pipeline,width:2,height:1,manifest:blob(6),pixels,pixelIdentity:hash(7),role:'derived',sourceAssetIds:['sourceA'],conversion:null};
 const asset={id:'derivedA',version:'1',purpose:'image',blob:blob(8,'image/png'),dependencies:[raster.manifest,pixels],safety:'safe',availability:'available',qualification:'canonical-raster',measuredMediaType:'image/png',raster};return {source,asset,manifest};
}
test('derived source closure requires the exact typed original and complete plan',()=>{
 const f=fixture();assert.equal(validateDerivedImportEdge(f.asset,f.manifest,f.source),f.manifest.plan);
 for(const mutate of [f=>{f.source.id='other';},f=>{f.source.blob=blob(9,'image/png');},f=>{f.source.qualification='canonical-raster';},f=>{f.manifest.dependencies=[];},f=>{f.asset.raster.sourceAssetIds.push('unrelated');},f=>{f.asset.raster.role='native';},f=>{f.asset.raster.conversion={resized:false};},f=>{f.manifest.plan.operation.x++;},f=>{f.manifest.plan.nativeScale=true;},f=>{f.manifest.plan.decodeTransport='jpeg-scanline-file-v1';},f=>{f.manifest.plan.decoderBuild=hash(9);}]){const changed=fixture();mutate(changed);assert.throws(()=>validateDerivedImportEdge(changed.asset,changed.manifest,changed.source));}
});
test('admitted replay must reproduce exact output, raw pixels, plan and tile identity',()=>{
 const f=fixture(),replay={png:f.asset.blob,info:f.asset.raster,manifest:f.manifest};assert.doesNotThrow(()=>verifyDerivedImportReplay(f.asset,f.manifest,replay));
 for(const mutate of [r=>{r.png.hash=hash(9);},r=>{r.info.pixels.hash=hash(9);},r=>{r.info.pixelIdentity=hash(9);},r=>{r.manifest.plan.inspectionHash=hash(9);},r=>{r.info.pipeline='other';}]){const changed=structuredClone(replay);mutate(changed);assert.throws(()=>verifyDerivedImportReplay(f.asset,f.manifest,changed));}
});

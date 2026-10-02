import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
// The normal root server build is required. This is the actual validator and
// its real protocol dependency graph, never a permissive fixture substitute.
export const assetProjectionURL=pathToFileURL(resolve('dist/local/src/protocol/asset-projection.js')).href;
const defaultHash='sha256:'+'a'.repeat(64);
export function assetProjection(value){return {protocolVersion:1,entityVersion:value.version,projectionSchema:value.raster?.role==='derived'?3:2,highWater:'1',projection:{kind:'inline',value}};}
export function canonicalDisplayAsset({id='retained',version='1',width=1,height=1,pixelIdentity=defaultHash,pixelHash=defaultHash,encodedHash=defaultHash,encodedBytes='24',encodedType='image/png',safety='safe',availability='available'}={}){
 const manifest={hash:defaultHash,byteLength:'2',mediaType:'application/json'},pixels={hash:pixelHash,byteLength:String(width*height*4),mediaType:'application/x-ideogram-rgba8'},jpeg=encodedType==='image/jpeg';
 return {id,version,purpose:'image',blob:{hash:encodedHash,byteLength:encodedBytes,mediaType:encodedType},dependencies:[manifest,pixels],safety,availability,qualification:jpeg?'canonical-jpeg':'canonical-raster',measuredMediaType:encodedType,raster:{schemaVersion:1,pipeline:'cp1-f64-triangle-area-v1/'+defaultHash,width,height,manifest,pixels,pixelIdentity,role:jpeg?'export':'composite',sourceAssetIds:[],conversion:null}};
}

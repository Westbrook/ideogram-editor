import type {BlobRef} from './store.js';
import type {RasterInfo} from './raster.js';

export const ENCODED_COMPOSITION_BYTES=4*1024**2;

/** Immutable review identities only. Filesystem capabilities never cross the protocol. */
export type EncodedRasterIdentity={
  assetId:string;assetVersion:string;assetHash:string;info:RasterInfo;
  encoding:'canonical-png'|'candidate-original';encoded:BlobRef;encodedAssetId:string;
};
export type EncodedR16Identity={encoded:BlobRef;pixels:BlobRef;width:number;height:number;codec:'r16le-deflate-v1'};
export type EncodedAdoptionInputs={
  kind:'encoded-adoption-inputs-1';source:EncodedRasterIdentity;candidate:EncodedRasterIdentity;
  mask:{assetId:string;assetVersion:string;assetHash:string;info:RasterInfo;authored:EncodedR16Identity;effective:EncodedR16Identity;approved:EncodedR16Identity};
};

import type {RasterLayer} from './raster.js';
import {blob,id,seq,keys,requireValue as ok,rasterInfo} from './validate.js';
import {extent,inverse} from '../raster/core.js';
import {validateMaskMapping,r16Mask,maskGrid} from '../raster/mapping.js';
export type EncodedCompositionMaskIdentity={assetId:string;assetVersion:string;assetHash:string;info:RasterInfo;coverage:EncodedR16Identity};
export type EncodedCompositionInputs={kind:'encoded-composition-inputs-1';width:number;height:number;candidateAssetId:string;layers:readonly RasterLayer[];images:readonly EncodedRasterIdentity[];masks:readonly EncodedCompositionMaskIdentity[]};
/** This checks metadata shape and exact graph closure, never filesystem proof authority. */
export function validateEncodedCompositionLayers(width:number,height:number,layers:readonly RasterLayer[]):void{
 extent(width,height);ok(Array.isArray(layers)&&layers.length<=100);
 for(const layer of layers){keys(layer,['assetId','transform','opacity','mask']);ok(id(layer.assetId)&&Array.isArray(layer.transform)&&layer.transform.length===6&&layer.transform.every(Number.isFinite)&&Number.isFinite(layer.opacity)&&layer.opacity>=0&&layer.opacity<=1);inverse(layer.transform);if(layer.mask!==null)validateMaskMapping(layer.mask);}
}
export function validateEncodedCompositionInputs(v:any):asserts v is EncodedCompositionInputs{
 keys(v,['kind','width','height','candidateAssetId','layers','images','masks']);ok(v.kind==='encoded-composition-inputs-1'&&id(v.candidateAssetId));validateEncodedCompositionLayers(v.width,v.height,v.layers);
 ok(v.layers.filter((l:RasterLayer)=>l.assetId===v.candidateAssetId).length===1&&v.layers.every((l:RasterLayer)=>l.mask?.assetId!==v.candidateAssetId));
 ok(Array.isArray(v.images)&&Array.isArray(v.masks)&&v.images.length+v.masks.length<200);
 const expectedImages=new Set<string>(),expectedMasks=new Set<string>();for(const layer of v.layers as RasterLayer[]){if(layer.assetId!==v.candidateAssetId)expectedImages.add(layer.assetId);if(layer.mask)(r16Mask(layer.mask)?expectedMasks:expectedImages).add(layer.mask.assetId);}
 ok([...expectedImages].every(assetId=>!expectedMasks.has(assetId)));
 const seen=new Set<string>();
 for(const image of v.images){keys(image,['assetId','assetVersion','assetHash','info','encoding','encoded','encodedAssetId']);ok(id(image.assetId)&&seq(image.assetVersion)&&/^sha256:[a-f0-9]{64}$/.test(image.assetHash)&&image.encoding==='canonical-png'&&image.encodedAssetId===image.assetId&&!seen.has(image.assetId)&&expectedImages.has(image.assetId));seen.add(image.assetId);rasterInfo(image.info);ok(image.info.role!=='mask');blob(image.encoded);ok(image.encoded.mediaType==='image/png'&&BigInt(image.encoded.byteLength)>0n&&BigInt(image.encoded.byteLength)<=268435456n);}
 ok(seen.size===expectedImages.size);seen.clear();
 for(const mask of v.masks){keys(mask,['assetId','assetVersion','assetHash','info','coverage']);ok(id(mask.assetId)&&seq(mask.assetVersion)&&/^sha256:[a-f0-9]{64}$/.test(mask.assetHash)&&!seen.has(mask.assetId)&&expectedMasks.has(mask.assetId));seen.add(mask.assetId);rasterInfo(mask.info);ok(mask.info.role==='mask');const c=mask.coverage;keys(c,['encoded','pixels','width','height','codec']);extent(c.width,c.height);blob(c.encoded);blob(c.pixels);ok(c.codec==='r16le-deflate-v1'&&c.encoded.mediaType==='application/x-ideogram-r16le-deflate'&&BigInt(c.encoded.byteLength)>0n&&BigInt(c.encoded.byteLength)<=67108864n&&c.pixels.mediaType==='application/x-ideogram-r16le'&&c.pixels.byteLength===String(c.width*c.height*2)&&c.width===mask.info.width&&c.height===mask.info.height);}
 ok(seen.size===expectedMasks.size);
 for(const layer of v.layers as RasterLayer[])if(layer.mask){const source=r16Mask(layer.mask)?v.masks.find((x:EncodedCompositionMaskIdentity)=>x.assetId===layer.mask!.assetId):v.images.find((x:EncodedRasterIdentity)=>x.assetId===layer.mask!.assetId);const g=maskGrid(layer.mask,v.width,v.height);ok(source&&source.info.width===g.width&&source.info.height===g.height);}
}

function encodedRaster(v:any):void{
 keys(v,['assetId','assetVersion','assetHash','info','encoding','encoded','encodedAssetId']);ok(id(v.assetId)&&seq(v.assetVersion)&&/^sha256:[a-f0-9]{64}$/.test(v.assetHash)&&id(v.encodedAssetId)&&['canonical-png','candidate-original'].includes(v.encoding));rasterInfo(v.info);ok(v.info.role!=='mask');blob(v.encoded);ok(['image/png','image/jpeg','image/webp'].includes(v.encoded.mediaType)&&BigInt(v.encoded.byteLength)>0n&&BigInt(v.encoded.byteLength)<=268435456n);if(v.encoding==='canonical-png')ok(v.encodedAssetId===v.assetId&&v.encoded.mediaType==='image/png');
}
function encodedR16(v:any):void{keys(v,['encoded','pixels','width','height','codec']);extent(v.width,v.height);blob(v.encoded);blob(v.pixels);ok(v.codec==='r16le-deflate-v1'&&v.encoded.mediaType==='application/x-ideogram-r16le-deflate'&&BigInt(v.encoded.byteLength)>0n&&BigInt(v.encoded.byteLength)<=67108864n&&v.pixels.mediaType==='application/x-ideogram-r16le'&&v.pixels.byteLength===String(v.width*v.height*2));}
export function validateEncodedAdoptionInputs(v:any):asserts v is EncodedAdoptionInputs{
 keys(v,['kind','source','candidate','mask']);ok(v.kind==='encoded-adoption-inputs-1');encodedRaster(v.source);encodedRaster(v.candidate);ok(v.source.encoding==='canonical-png'&&v.candidate.encoding==='candidate-original');
 const m=v.mask;keys(m,['assetId','assetVersion','assetHash','info','authored','effective','approved']);ok(id(m.assetId)&&seq(m.assetVersion)&&/^sha256:[a-f0-9]{64}$/.test(m.assetHash));rasterInfo(m.info);ok(m.info.role==='mask');for(const r of [m.authored,m.effective,m.approved]){encodedR16(r);ok(r.width===m.info.width&&r.height===m.info.height);}
}

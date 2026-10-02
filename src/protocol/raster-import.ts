import type { BlobRef } from './store.js';
import type {Receipt} from './store.js';
import { extent } from '../raster/core.js';
import { keys, id, seq, requireValue as ok, blob } from './validate.js';

/** Encoded input geometry is distinct from the unchanged working-raster cap. */
export function encodedExtent(width:number,height:number):void {
 if(![width,height].every(value=>Number.isInteger(value)&&value>0&&value<=0x7fffffff))throw Error('RASTER_EXTENT');
}
export type RasterImportOperation =
 | {kind:'resize';width:number;height:number}
 | {kind:'crop';x:number;y:number;width:number;height:number};
export type RasterImportInspection = {
 schemaVersion:1;kind:'raster-import-inspection-v1';protocolVersion:1;inspectionId:string;assetId:string;assetVersion:string;original:BlobRef;
 encoded:{width:number;height:number};orientation:number;profile:'untagged-srgb'|'srgb'|'p3';profileHash:string|null;
 /** Container inspection never asserts that image samples have been decoded. */
 samplesValidated:false;inspectionHash:string;
 capabilities:{resize:string|null;crop:string|null;unavailableReason:string|null};
 targetClientId:string;expiresAt:string;
};
export type RasterImportPlan = {inspectionId:string;inspectionHash:string;operation:RasterImportOperation};
export type RasterImportCancellation={protocolVersion:1;commandId:string;status:'canceled'|'completed';receipt:Receipt};

/** Immutable default retained by the writer before any import can be admitted. */
export const RASTER_IMPORT_CANCELLATION_REF:Readonly<BlobRef>=Object.freeze({"hash":"sha256:6ae6e6216811241251b4d3e8e4d8b1c5821ec25840f8555dfd8d9b0186a359b5","byteLength":"84","mediaType":"application/json"});
/** Complete wire proof. A terminal server reply never substitutes for receipt validation. */
export function rasterImportCancellation(value:any,commandId:string):asserts value is RasterImportCancellation {
 keys(value,['protocolVersion','commandId','status','receipt']);
 ok(id(commandId)&&value.protocolVersion===1&&value.commandId===commandId&&['canceled','completed'].includes(value.status));
 const r=value.receipt;ok(r&&typeof r==='object');
 if(r.status==='accepted'){
  keys(r,['status','commandId','fromSeq','toSeq','documentRevision','transactionId']);
  ok(r.commandId===commandId&&seq(r.fromSeq)&&seq(r.toSeq)&&BigInt(r.fromSeq)>0n&&BigInt(r.toSeq)>=BigInt(r.fromSeq)&&r.documentRevision===null&&id(r.transactionId)&&value.status==='completed');
 }else{
  keys(r,['status','commandId','code','currentRevision','details']);
  ok(r.status==='rejected'&&r.commandId===commandId&&['STALE_REVISION','INVALID_INPUT','MISSING_ASSET','CAPACITY','INCOMPATIBLE'].includes(r.code)&&r.currentRevision===null);blob(r.details);
  ok(r.details.mediaType==='application/json'&&BigInt(r.details.byteLength)>0n&&BigInt(r.details.byteLength)<=65536n);
  if(r.details.hash===RASTER_IMPORT_CANCELLATION_REF.hash)ok(r.details.byteLength===RASTER_IMPORT_CANCELLATION_REF.byteLength&&r.code==='INVALID_INPUT');
  const canceled=r.code==='INVALID_INPUT'&&r.details.hash===RASTER_IMPORT_CANCELLATION_REF.hash&&r.details.byteLength===RASTER_IMPORT_CANCELLATION_REF.byteLength&&r.details.mediaType===RASTER_IMPORT_CANCELLATION_REF.mediaType;
  ok((value.status==='canceled')===canceled);
 }
}
export type RasterImportTransport='png-scanline-file-cp1-v1'|'jpeg-scanline-file-v1'|'webp-advanced-file-v1';
export type DecodedDerivedPlan={kind:'decoded-derived-v1';sourceAssetId:string;original:BlobRef;inspectionHash:string;encoded:{width:number;height:number};orientation:number;profile:'untagged-srgb'|'srgb'|'p3';profileHash:string|null;operation:RasterImportOperation;kernel:'triangle-area-source-axis-row-norm-v1';codec:string;decodeTransport:RasterImportTransport;decoderSource:string;decoderBuild?:string;decoderABI?:number};
export function importOperation(value:any,width:number,height:number):void {
 encodedExtent(width,height);keys(value,value.kind==='crop'?['kind','x','y','width','height']:['kind','width','height']);
 ok(value.kind==='resize'||value.kind==='crop');extent(value.width,value.height);
 if(value.kind==='crop')ok(Number.isSafeInteger(value.x)&&Number.isSafeInteger(value.y)&&value.x>=0&&value.y>=0&&value.x+value.width<=width&&value.y+value.height<=height);
}
export function importPlan(value:any,width:number,height:number):void {
 keys(value,['inspectionId','inspectionHash','operation']);ok(id(value.inspectionId)&&/^sha256:[a-f0-9]{64}$/.test(value.inspectionHash));importOperation(value.operation,width,height);
}
export function retainedOriginal(value:any):void {
 keys(value,['assetId','version','blob']);ok(id(value.assetId)&&/^[1-9][0-9]*$/.test(value.version));blob(value.blob);
 ok(['image/png','image/jpeg','image/webp'].includes(value.blob.mediaType));
}
export function rasterImportInspection(value:any):void {
 keys(value,['schemaVersion','kind','protocolVersion','inspectionId','assetId','assetVersion','original','encoded','orientation','profile','profileHash','samplesValidated','inspectionHash','capabilities','targetClientId','expiresAt']);
 ok(value.schemaVersion===1&&value.kind==='raster-import-inspection-v1'&&value.protocolVersion===1&&id(value.inspectionId)&&id(value.assetId)&&/^[1-9][0-9]*$/.test(value.assetVersion)&&id(value.targetClientId)&&typeof value.expiresAt==='string'&&Number.isFinite(Date.parse(value.expiresAt)));
 blob(value.original);ok(['image/png','image/jpeg','image/webp'].includes(value.original.mediaType));keys(value.encoded,['width','height']);encodedExtent(value.encoded.width,value.encoded.height);
 ok(Number.isInteger(value.orientation)&&value.orientation>=1&&value.orientation<=8&&['untagged-srgb','srgb','p3'].includes(value.profile)&&(value.profile==='untagged-srgb'?value.profileHash===null:/^sha256:[a-f0-9]{64}$/.test(value.profileHash))&&value.samplesValidated===false&&/^sha256:[a-f0-9]{64}$/.test(value.inspectionHash));
 const transport:Record<string,string>={'image/png':'png-scanline-file-cp1-v1','image/jpeg':'jpeg-scanline-file-v1','image/webp':'webp-advanced-file-v1'};
 keys(value.capabilities,['resize','crop','unavailableReason']);for(const key of ['resize','crop'])ok(value.capabilities[key]===null||value.capabilities[key]===transport[value.original.mediaType]);
 ok(value.capabilities.unavailableReason===null||typeof value.capabilities.unavailableReason==='string'&&/^[A-Z0-9_]{1,128}$/.test(value.capabilities.unavailableReason));
}
/** Shape proof only. Raster-profile resolution separately proves known producers. */
export function decodedDerivedPlan(value:any,width:number,height:number):void {
 const common=['kind','sourceAssetId','original','inspectionHash','encoded','orientation','profile','profileHash','operation','kernel','codec','decodeTransport','decoderSource'];
 keys(value,value.decodeTransport==='png-scanline-file-cp1-v1'?common:[...common,'decoderBuild','decoderABI']);
 ok(value.kind==='decoded-derived-v1'&&id(value.sourceAssetId));blob(value.original);keys(value.encoded,['width','height']);encodedExtent(value.encoded.width,value.encoded.height);
 const transport:Record<string,string>={'image/png':'png-scanline-file-cp1-v1','image/jpeg':'jpeg-scanline-file-v1','image/webp':'webp-advanced-file-v1'};
 ok(transport[value.original.mediaType]!==undefined&&value.decodeTransport===transport[value.original.mediaType]&&Number.isInteger(value.orientation)&&value.orientation>=1&&value.orientation<=8);
 ok(['untagged-srgb','srgb','p3'].includes(value.profile)&&(value.profile==='untagged-srgb'?value.profileHash===null:/^sha256:[a-f0-9]{64}$/.test(value.profileHash)));
 for(const key of ['inspectionHash','codec','decoderSource'])ok(/^sha256:[a-f0-9]{64}$/.test(value[key]));
 ok(value.kernel==='triangle-area-source-axis-row-norm-v1');if(value.decodeTransport!=='png-scanline-file-cp1-v1')ok(/^sha256:[a-f0-9]{64}$/.test(value.decoderBuild)&&Number.isSafeInteger(value.decoderABI)&&value.decoderABI>0);
 importOperation(value.operation,value.orientation>=5?value.encoded.height:value.encoded.width,value.orientation>=5?value.encoded.width:value.encoded.height);
 extent(width,height);ok(width===value.operation.width&&height===value.operation.height);
}

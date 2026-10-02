import type {DatabaseSync} from 'node:sqlite';
import type {Asset} from '../../src/protocol/assets.js';
import type {RasterImportInspection,RasterImportPlan} from '../../src/protocol/raster-import.js';
import {rasterImportInspection,importPlan} from '../../src/protocol/raster-import.js';
import {orientedDimensions} from '../raster/import-file-transform.js';
import {canonical,hashBytes,isId} from './canonical.js';
import {AssetRejection,type AssetAuth} from './assets.js';
import {StoreError} from './errors.js';

export type ImportMetadata=Pick<RasterImportInspection,'encoded'|'orientation'|'profile'|'profileHash'|'capabilities'>;
/** Tables are created only by the centralized schema18 migration. */
export class RasterImportInspections {
 constructor(private db:DatabaseSync,private epoch:string,private asset:(id:string)=>Asset|null,private owner:(id:string,clientId:string)=>void,private fence:()=>void){}
 private original(id:string,clientId:string){
  this.fence();this.owner(id,clientId);const asset=this.asset(id);
  if(!asset||asset.availability!=='available')throw new AssetRejection('MISSING_ASSET','RASTER_ORIGINAL_MISSING');
  if(asset.qualification!=='pending-decoder'||asset.purpose!=='image'||!['image/png','image/jpeg','image/webp'].includes(asset.measuredMediaType)||asset.blob.mediaType!==asset.measuredMediaType)throw new AssetRejection('INCOMPATIBLE','RASTER_ORIGINAL_REQUIRED');
  return asset;
 }
 /** Prepare outside the transaction; caller must hold/recheck the original's byte proof. */
 prepare(inspectionId:string,assetId:string,metadata:ImportMetadata,auth:AssetAuth){
  if(!isId(inspectionId))throw new StoreError('MALFORMED_REQUEST');const authority={...auth},original=this.original(assetId,auth.clientId),identity=canonical(original);
  if(auth.now>=auth.expires)throw new StoreError('REVIEW_EXPIRED');
  const value={schemaVersion:1 as const,kind:'raster-import-inspection-v1' as const,protocolVersion:1 as const,inspectionId,assetId,assetVersion:original.version,original:original.blob,...metadata,samplesValidated:false as const,targetClientId:auth.clientId,expiresAt:new Date(Math.min(auth.expires,auth.now+1800000)).toISOString()};
  const inspection:RasterImportInspection={...value,inspectionHash:hashBytes(canonical(value))};rasterImportInspection(inspection);
  const sealedJSON=canonical(inspection),expiresAt=Date.parse(inspection.expiresAt),inspectionHash=inspection.inspectionHash;
  if(Buffer.byteLength(sealedJSON)>65536)throw new StoreError('PAYLOAD_TOO_LARGE');
  return {inspection,commit:(current:AssetAuth)=>{
   this.fence();if(!this.db.isTransaction)throw new StoreError('CORRUPT_STORE');
   if(current.clientId!==authority.clientId||current.sessionHash!==authority.sessionHash||current.now>=current.expires||current.now>=expiresAt)throw new AssetRejection('INVALID_INPUT','RASTER_IMPORT_INSPECTION_EXPIRED');
   if(canonical(this.original(assetId,current.clientId))!==identity)throw new AssetRejection('STALE_REVISION','RASTER_ORIGINAL_CHANGED');
   this.db.prepare('INSERT INTO raster_import_inspections VALUES (?,?,?,?)').run(inspectionId,sealedJSON,current.sessionHash,this.epoch);
   return {type:'RasterImportInspectionPrepared' as const,payload:{inspectionId,inspectionHash}};
  }};
 }
 read(id:string,auth:AssetAuth):RasterImportInspection {
  this.fence();if(!isId(id))throw new StoreError('MALFORMED_REQUEST');const row=this.db.prepare('SELECT * FROM raster_import_inspections WHERE id=?').get(id);if(!row)throw new StoreError('NOT_FOUND');
  let value:RasterImportInspection;try{if(typeof row.json!=='string'||Buffer.byteLength(row.json)>65536)throw Error();value=JSON.parse(row.json);rasterImportInspection(value);const {inspectionHash,...body}=value;if(value.inspectionId!==id||canonical(value)!==row.json||hashBytes(canonical(body))!==inspectionHash)throw Error();}catch{throw new StoreError('CORRUPT_STORE');}
  if(value.targetClientId!==auth.clientId)throw new StoreError('OWNER_REQUIRED');if(row.session_hash!==auth.sessionHash||row.epoch!==this.epoch||auth.now>=auth.expires||auth.now>=Date.parse(value.expiresAt))throw new StoreError('REVIEW_EXPIRED');return value;
 }
 authorize(assetId:string,plan:RasterImportPlan,auth:AssetAuth):RasterImportInspection {
  const inspection=this.read(plan.inspectionId,auth),dimensions=orientedDimensions(inspection.encoded.width,inspection.encoded.height,inspection.orientation);try{importPlan(plan,dimensions.width,dimensions.height);}catch{throw new AssetRejection('INVALID_INPUT','RASTER_IMPORT_PLAN_INVALID');}
  if(inspection.assetId!==assetId||inspection.inspectionHash!==plan.inspectionHash)throw new AssetRejection('STALE_REVISION','RASTER_IMPORT_INSPECTION_CHANGED');
  const current=this.original(assetId,auth.clientId);if(current.version!==inspection.assetVersion||canonical(current.blob)!==canonical(inspection.original))throw new AssetRejection('STALE_REVISION','RASTER_ORIGINAL_CHANGED');
  if(inspection.capabilities[plan.operation.kind]===null)throw new AssetRejection('INCOMPATIBLE',inspection.capabilities.unavailableReason??'BOUNDED_DECODER_UNAVAILABLE');
  return inspection;
 }
}

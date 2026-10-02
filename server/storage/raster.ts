import {historyCompositionReader,retainedCompositionReference} from './history-composition.js';
import {readComposition,compositionRefs} from './composition.js';
import {CompositionMemory} from './composition-memory.js';
import {DiagnosticRing,diagnosticReleases} from '../observability/diagnostic-memory.js';
import {DiagnosticReads,diagnosticPayloadBytes} from '../../src/observability/diagnostic-memory.js';
import {RASTER_IMPORT_CANCELLATION_REF,rasterImportCancellation} from '../../src/protocol/raster-import.js';
import {v45EditPreparation,v45EditInputsPlan,v45EditInputsReferences,type V45EditPreparation,type V45EditInputsPlan,type V45PreparedRaster,type V45PreparedBlack,type V45EditInputs} from '../../src/protocol/v45-inputs.js';
import {requireRequestMaskPlan,requireMaskAlignment,requestMaskDependencies,RequestError,type Source,type Mask} from '../../src/request/core.js';
import {requirePlanDependencies} from '../../src/request/raster-plan.js';
import {retainedMetadataReferences} from '../portable/retained.js';
import {imageState} from '../../src/protocol/history-validation.js';
import {maskImports,maskSource} from '../../src/raster/mask.js';
import {maskGrid,r16Mask} from '../../src/raster/mapping.js';
import type {Affine} from '../../src/raster/core.js';
import {RasterImportInspections} from './raster-import-inspections.js';
import {inspectRasterOriginal} from '../raster/inspect-original.js';
import {ACTIVE_IMPORT_PROFILES} from '../raster/import-profile.js';
import {CODEC_ID as IMPORT_BASE_CODEC_ID} from '../raster/codec-platform.js';
import {importProducerAvailable} from '../raster/import-producers.js';
import {validateDerivedImportEdge} from '../portable/imports.js';
import type {DecodedDerivedPlan,RasterImportInspection,RasterImportCancellation} from '../../src/protocol/raster-import.js';
import {sanitizePhaseContext,type PhaseContext} from '../../src/observability/phases.js';
import type {RasterWorkerSnapshot} from '../raster/active-compute.js';
import {validateRequestRasterPlan,requireOutputMapping,type RequestRasterPlan,type RequestOutputMapping} from '../../src/request/raster-plan.js';
import {validateRequestSourceCapture,type RequestSourceCapture} from '../../src/protocol/request-edits.js';
import {RasterWorkerOwner} from '../raster/worker-owner.js';
import {retainedTextResourcePlan,compositionResourcePlan} from '../raster/resource-plan.js';
import {adapterResources} from '../observability/adapter-resources.js';
import { randomUUID,createHash } from 'node:crypto';
import { join, basename, dirname } from 'node:path';
import { rmSync,openSync,closeSync,readSync,fstatSync,constants,writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Asset, AssetFact } from '../../src/protocol/assets.js';
import type { BlobRef, Receipt } from '../../src/protocol/store.js';
import type { RasterReview, RasterManifest } from '../../src/protocol/raster.js';
import type { RasterBody } from '../../src/protocol/raster.js';
import type { RasterJob, RasterResult, ResourcePlan, InputRaster } from '../raster/engine.js';
import { canonical, hashBytes, isId, parseCommand, validateBlob } from './canonical.js';
import { StoreError, safeError } from './errors.js';
import { AssetRejection } from './assets.js';
import type { Assets, AssetAuth } from './assets.js';
import type { Objects, Barrier } from './objects.js';
import { privateDirectory, assertComponents, assertPrivate, syncDirectory,sameFile } from './files.js';
import { asset as validateAsset, rasterManifest as validateManifest, contributionStack } from '../../src/protocol/validate.js';
import { parseControlJSON } from '../control-json.js';
import { lineageRecord, lineageAssetIds } from '../portable/lineage.js';
import {validateEncodedCompositionInputs,validateEncodedCompositionLayers,type EncodedAdoptionInputs,type EncodedRasterIdentity,type EncodedR16Identity,type EncodedCompositionInputs,type EncodedCompositionMaskIdentity} from '../../src/protocol/encoded-rebuild.js';
import type {EncodedRasterFile,EncodedRasterJob,EncodedCompositionMaskFile,LetteringComparison} from '../raster/encoded-input.js';
import {encodeR16,R16_ENCODED_CODEC,R16_ENCODED_MEDIA_TYPE,R16_ENCODED_ALLOCATION_BYTES} from '../raster/r16-encoded.js';

// Keep codec/native raster modules out of the writer. Hash only the bounded
// encoded transport just created here; decoded image work stays in the worker.
function encodedFileRef(path:string,mediaType:string,check:()=>void):BlobRef{
  assertComponents(dirname(path));const before=assertPrivate(path,false),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{if(!sameFile(before,fstatSync(fd)))throw new StoreError('CORRUPT_OBJECT');const digest=createHash('sha256'),buffer=Buffer.alloc(65536);let count=0,n;
    while((n=readSync(fd,buffer))){check();digest.update(buffer.subarray(0,n));count+=n;}return {hash:'sha256:'+digest.digest('hex'),byteLength:String(count),mediaType};
  }finally{closeSync(fd);}
}

export const isRasterCommand=(type:string)=>['InspectRasterOriginal','PrepareV45EditInputs','PrepareMask','PrepareRequestMask','PrepareRaster','ReviewRaster','ApproveRaster','ComposeRaster','ExportRaster'].includes(type);
export const RASTER_IMPORT_CANCELLATION_JSON=canonical({kind:'fields',issues:[{path:'command.body',code:'RASTER_IMPORT_CANCELED'}]});
export {RASTER_IMPORT_CANCELLATION_REF} from '../../src/protocol/raster-import.js';
type Commit=(bytes:Uint8Array,build:()=>AssetFact,failure?:()=>void,slot?:string)=>Receipt;
export class Rasters {
  private documentBusy = false;
  private directory:string;private running:Promise<void>|undefined;private closing=false;private paused=new Set<string>();private workerOwner=new RasterWorkerOwner();
  private observations=new DiagnosticRing<Record<string,unknown>>('diagnostic-raster-observations',32,1024**2,undefined,2*1024**2);private reservedCPU=0;
  private readonly diagnosticReads=new DiagnosticReads('diagnostic-rasters-read');
  private workerPhases=new DiagnosticRing<RasterWorkerSnapshot>('diagnostic-raster-phases',16,1024**2);
  externalCPU:()=>number=()=>0;
  readonly compositionMemory=new CompositionMemory(()=>this.reservedBytes+this.externalCPU());
  get reservedBytes(){return this.reservedCPU;}
  resourceOwnership(){return {running:!!this.running,documentBusy:this.documentBusy,activeWorkers:this.workerOwner.snapshot.activeJobs,workerService:this.workerOwner.snapshot,bookedCPUBytes:this.reservedCPU,approvalAuthorities:this.approvalAuth.size,compositionMemory:this.compositionMemory.resourceOwnership()};}
  private approvalAuth=new Map<string,{auth:AssetAuth;started:number}>();
  private runningId:string|undefined;
  private imports:RasterImportInspections;
  private retainedImportCleanup=new Set<string>();
  private portableComparisonScratch=new Map<string,string>();
  private importCancellations=new Map<string,SharedArrayBuffer>();
  constructor(private db:DatabaseSync,private objects:Objects,private assets:Assets,root:string,private epoch:string,private check:()=>void,private barrier:Barrier,private commit:Commit,private register:(owner:string,ref:BlobRef,proof:string)=>void){
    this.directory=join(root,'raster-work');privateDirectory(this.directory);
    this.imports=new RasterImportInspections(db,epoch,id=>assets.asset(id),(id,client)=>this.owner(id,client),check);
    // A new writer epoch has no old worker. Retry/cancel cleanup is exact to
    // each journaled import directory, before any pending operation resumes.
    for(const row of db.prepare("SELECT DISTINCT document_id FROM deletion_work WHERE document_id LIKE 'raster-import:%'").all())this.cleanupImport(String(row.document_id).slice(14));
    // A committed export receipt owns no mutable worker output. After restart
    // there are no surviving workers or proofs, so finish interrupted cleanup.
    const exportPrefix=join(this.directory,'export-');
    for(const row of this.db.prepare('SELECT path FROM deletion_work WHERE substr(path,1,length(?))=?').all(exportPrefix,exportPrefix)){
      const name=basename(String(row.path)),match=/^export-([A-Za-z0-9_-]{1,128})\.[0-9a-f-]{36}$/.exec(name);
      if(match&&dirname(String(row.path))===this.directory&&this.db.prepare("SELECT 1 FROM commands WHERE id=? AND json_extract(canonical,'$.command.body.type')='ExportDocument'").get(match[1]))this.cleanupDocumentExport(match[1]);
    }
  }
  /** Call after domain and candidate asset journals replay, before writer readiness. */
  validateRetainedManifests():void {
    // Deletion drops ownership before its collector unlinks bytes. Retained
    // asset rows remain replay records; only rooted manifests are live graphs.
    for(const row of this.db.prepare("SELECT id FROM assets WHERE json_type(json,'$.raster')='object' AND EXISTS(SELECT 1 FROM roots WHERE hash=json_extract(assets.json,'$.raster.manifest.hash'))").iterate())try{this.manifest(String(row.id));}catch(e){if(!(e instanceof StoreError)||!['MISSING_OBJECT','CORRUPT_OBJECT'].includes(e.code))throw e;}
  }
  private transaction<T>(run:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{this.check();const result=run();this.db.exec('COMMIT');return result;}catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}}
  importInspection(id:string,auth:AssetAuth){return this.imports.read(id,auth);}
  private importAuthority(id:string):AssetAuth {
    try{return this.approvalAuthority(id);}catch{throw new AssetRejection('INVALID_INPUT','RASTER_IMPORT_INSPECTION_EXPIRED');}
  }
  private importPlan(assetId:string,body:Extract<RasterBody,{type:'PrepareRaster'}>,id:string):RasterImportInspection {
    try{return this.imports.authorize(assetId,body.importPlan!,this.importAuthority(id));}
    catch(error){if(error instanceof AssetRejection)throw error;if(error instanceof StoreError&&['REVIEW_EXPIRED','NOT_FOUND','OWNER_REQUIRED'].includes(error.code))throw new AssetRejection('INVALID_INPUT','RASTER_IMPORT_INSPECTION_EXPIRED');throw error;}
  }
  private retireTerminalImport(id:string){if(this.db.prepare('SELECT 1 FROM commands WHERE id=?').get(id)){this.approvalAuth.delete(id);this.paused.delete(id);}}
  private cleanupImport(id:string){
    if(!isId(id))throw new StoreError('CORRUPT_STORE');const prefix=join(this.directory,'import-'+id+'.');
    for(const row of this.db.prepare('SELECT path FROM deletion_work WHERE document_id=?').all('raster-import:'+id)){
      const path=String(row.path);if(dirname(path)!==this.directory||!path.startsWith(prefix)||!/^import-[A-Za-z0-9_-]{1,128}\.[0-9a-f-]{36}$/.test(basename(path)))throw new StoreError('ROOT_UNSAFE');
      if(this.db.prepare('SELECT 1 FROM deletion_backup_files WHERE substr(path,1,length(?))=? LIMIT 1').get(path+'/',path+'/'))continue;
      assertComponents(this.directory);try{assertPrivate(path,true);rmSync(path,{recursive:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      // A prior unlink may have succeeded before fsync failed. Absence still
      // requires a fresh durability proof before dropping the journal claim.
      syncDirectory(this.directory);this.db.prepare('DELETE FROM deletion_work WHERE path=?').run(path);
    }
    if(this.db.prepare('SELECT 1 FROM deletion_work WHERE document_id=?').get('raster-import:'+id))return false;
    if(this.retainedImportCleanup.delete(id)&&this.runningId!==id){this.objects.unreserve('raster:'+id);this.objects.release('raster:'+id);}
    this.retireTerminalImport(id);return true;
  }
  async cancelImport(id:string,auth:AssetAuth):Promise<RasterImportCancellation>{
    this.check();if(!isId(id))throw new StoreError('MALFORMED_REQUEST');
    const binding=this.db.prepare('SELECT client_id,expires FROM client_bindings WHERE cookie_hash=?').get(auth.sessionHash);
    if(auth.now>=auth.expires||!binding||binding.client_id!==auth.clientId||auth.now>=Number(binding.expires))throw new StoreError('OWNER_REQUIRED');
    const row=this.db.prepare('SELECT original,canonical,hash,receipt FROM commands WHERE id=?').get(id),pending=row?null:this.pending(id);
    let command=pending?.command;
    if(row)try{const request=parseCommand(Buffer.from(String(row.original)));if(request.command.commandId!==id||canonical(request)!==row.canonical||hashBytes(String(row.canonical))!==row.hash)throw Error();command=request.command;}catch{throw new StoreError('CORRUPT_STORE');}
    if(!command)throw new StoreError('NOT_FOUND');if(command.clientId!==auth.clientId)throw new StoreError('OWNER_REQUIRED');if(!['InspectRasterOriginal','PrepareRaster'].includes(command.body.type))throw new StoreError('MALFORMED_REQUEST');
    const receipt:Receipt=row?JSON.parse(String(row.receipt)):this.commit(Buffer.from(String(this.db.prepare('SELECT original FROM raster_preparations WHERE id=?').get(id)!.original)),()=>{throw new AssetRejection('INVALID_INPUT','RASTER_IMPORT_CANCELED');});
    const result={protocolVersion:1,commandId:id,status:receipt.status==='rejected'&&receipt.code==='INVALID_INPUT'&&canonical(receipt.details)===canonical(RASTER_IMPORT_CANCELLATION_REF)?'canceled':'completed',receipt};
    try{rasterImportCancellation(result,id);}catch{throw new StoreError('CORRUPT_STORE');}
    const running=this.runningId===id?this.running:undefined;if(running){const flag=this.importCancellations.get('raster:'+id);if(flag)Atomics.store(new Uint32Array(flag),0,1);await this.workerOwner.interrupt('raster:'+id);await running;}if(!this.cleanupImport(id))throw new StoreError('CAPACITY');
    return result;
  }
  async stopDocumentExport(commandId:string){await this.workerOwner.interrupt('history:'+commandId);}
  cleanupDocumentExport(commandId:string){
    if(!isId(commandId))throw new StoreError('MALFORMED_REQUEST');
    const terminal=this.db.prepare('SELECT original,canonical,hash,receipt FROM commands WHERE id=?').get(commandId);if(!terminal)return;
    try{const request=parseCommand(Buffer.from(String(terminal.original))),receipt=JSON.parse(String(terminal.receipt));if(request.command.commandId!==commandId||request.command.body.type!=='ExportDocument'||canonical(request)!==terminal.canonical||hashBytes(String(terminal.canonical))!==terminal.hash||receipt.commandId!==commandId||!['accepted','rejected'].includes(receipt.status))throw Error();}catch{throw new StoreError('CORRUPT_STORE');}
    const prefix=join(this.directory,'export-'+commandId+'.');
    for(const row of this.db.prepare('SELECT path FROM deletion_work WHERE substr(path,1,length(?))=?').all(prefix,prefix)){
      const path=String(row.path);if(dirname(path)!==this.directory||!/^export-[A-Za-z0-9_-]{1,128}\.[0-9a-f-]{36}$/.test(basename(path)))throw new StoreError('ROOT_UNSAFE');
      // Independently retained migration-backup bytes are never export scratch.
      if(this.db.prepare('SELECT 1 FROM deletion_backup_files WHERE substr(path,1,length(?))=? LIMIT 1').get(path+'/',path+'/'))continue;
      try{assertComponents(this.directory);assertPrivate(path,true);rmSync(path,{recursive:true});syncDirectory(this.directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      this.db.prepare('DELETE FROM deletion_work WHERE path=?').run(path);
    }
  }
  private asset(id:string,eligible=false){const a=this.assets.asset(id);if(!a)throw new AssetRejection('MISSING_ASSET','RASTER_INPUT_MISSING');
    if(a.availability!=='available'||['withheld','quarantined'].includes(a.safety))throw new AssetRejection('INCOMPATIBLE','RASTER_INPUT_WITHHELD');
    if(eligible&&(a.qualification!=='canonical-raster'||a.safety!=='safe'||!a.raster))throw new AssetRejection('INCOMPATIBLE','RASTER_REVIEW_REQUIRED');return a;}
  private owner(id:string,clientId:string){const row=this.db.prepare("SELECT c.canonical FROM events_v2 e JOIN commands c ON e.command_id=c.id WHERE json_extract(e.json,'$.type')='AssetRegistered' AND json_extract(e.json,'$.payload.asset.id')=?").get(id);
    if(!row||JSON.parse(String(row.canonical)).command.clientId!==clientId)throw new StoreError('OWNER_REQUIRED');}
  pending(id:string){if(!isId(id))throw new StoreError('MALFORMED_REQUEST');const r=this.db.prepare('SELECT * FROM raster_preparations WHERE id=?').get(id);if(!r)return null;
    try{const request=parseCommand(Buffer.from(String(r.original))),c=request.command;if(c.commandId!==id||canonical(request)!==r.canonical||hashBytes(String(r.canonical))!==r.hash||!['InspectRasterOriginal','PrepareV45EditInputs','PrepareMask','PrepareRequestMask','PrepareRaster','ApproveRaster','ComposeRaster','ExportRaster'].includes(c.body.type)||!isId(r.operation_id)||!['preparing','waiting-for-resources'].includes(String(r.phase)))throw new Error();
      return {command:c,hash:String(r.hash),operationId:String(r.operation_id),phase:String(r.phase) as 'preparing'|'waiting-for-resources'};
    }catch{throw new StoreError('CORRUPT_STORE');}}
  review(id:string,auth:AssetAuth):RasterReview{this.check();if(!isId(id))throw new StoreError('MALFORMED_REQUEST');const row=this.db.prepare('SELECT * FROM raster_reviews WHERE id=?').get(id);if(!row)throw new StoreError('NOT_FOUND');const r=JSON.parse(String(row.json)) as RasterReview;
    if(r.targetClientId!==auth.clientId)throw new StoreError('OWNER_REQUIRED');if(row.session_hash!==auth.sessionHash||row.epoch!==this.epoch||auth.now>=Date.parse(r.expiresAt))throw new StoreError('REVIEW_EXPIRED');return r;}
  manifest(id:string):RasterManifest{
    const asset=this.assets.asset(id);if(!asset?.raster)throw new StoreError('NOT_FOUND');
    return this.assetManifest(asset);
  }
  contributionRefs(manifest:RasterManifest):BlobRef[]{
    const plan=manifest.plan as {kind:string;contributions?:BlobRef;layers?:readonly import('../../src/protocol/raster.js').RasterLayer[]};
    if(plan.kind!=='request-source-capture-v1'||!plan.contributions)return [];
    const read=(ref:BlobRef)=>{const bytes=this.objects.verify(ref,true)!,value=parseControlJSON(bytes);if(canonical(value)!==Buffer.from(bytes).toString('utf8'))throw new StoreError('CORRUPT_OBJECT');return value;};
    const stack=read(plan.contributions) as {pipeline:string;width:number;height:number;contributions:{manifest:BlobRef;pixels:BlobRef;pixelIdentity:string}[]};contributionStack(stack);
    if(stack.pipeline!==manifest.pipeline||stack.width!==manifest.width||stack.height!==manifest.height||stack.contributions.length!==plan.layers!.length)throw new StoreError('CORRUPT_OBJECT');
    const refs=new Map<string,BlobRef>(),add=(ref:BlobRef)=>refs.set(canonical(ref),ref);add(plan.contributions);
    for(let i=0;i<stack.contributions.length;i++){
      const entry=stack.contributions[i],value=read(entry.manifest) as RasterManifest;validateManifest(value);
      const layer=plan.layers![i],p=value.plan as {kind:string;layer:unknown;source:BlobRef;mask:BlobRef|null},source=this.assets.asset(layer.assetId),mask=layer.mask?this.assets.asset(layer.mask.assetId):null;
      if(p.kind!=='cp1-layer-contribution-v1'||value.pipeline!==stack.pipeline||value.width!==stack.width||value.height!==stack.height||canonical(value.pixels)!==canonical(entry.pixels)||hashBytes(canonical({pipeline:value.pipeline,width:value.width,height:value.height,tiles:value.tiles}))!==entry.pixelIdentity||canonical(p.layer)!==canonical(layer)||!source?.raster||canonical(p.source)!==canonical(source.raster.manifest)||(layer.mask?(!mask?.raster||canonical(p.mask)!==canonical(mask.raster.manifest)):p.mask!==null))throw new StoreError('CORRUPT_OBJECT');
      for(const ref of [entry.manifest,entry.pixels,...value.dependencies])add(ref);
    }
    return [...refs.values()];
  }
  private assetManifest(asset:Asset):RasterManifest{
    if(!asset.raster)throw new StoreError('NOT_FOUND');
    let manifest:RasterManifest;try{const bytes=this.objects.verify(asset.raster.manifest,true)!;const value=parseControlJSON(bytes);validateManifest(value);if(canonical(value)!==Buffer.from(bytes).toString('utf8'))throw new Error();manifest=value as RasterManifest;
      if(manifest.width!==asset.raster.width||manifest.height!==asset.raster.height||manifest.pipeline!==asset.raster.pipeline||canonical(manifest.pixels)!==canonical(asset.raster.pixels)||hashBytes(canonical({pipeline:manifest.pipeline,width:manifest.width,height:manifest.height,tiles:manifest.tiles}))!==asset.raster.pixelIdentity)throw new Error();
      const plan=manifest.plan as Record<string,unknown>;if(plan.kind==='solid-background-v1'&&(asset.raster.role!=='composite'||asset.raster.sourceAssetIds.length||asset.raster.conversion!==null))throw Error('BACKGROUND_ROLE');if((asset.raster.role==='mask')!==(['authored-mask-v1','authored-mask-v2','authored-request-mask-v1'].includes(String(plan.kind))))throw Error('MASK_ROLE');if(asset.raster.role==='mask'&&asset.raster.schemaVersion!==manifest.schemaVersion)throw Error('MASK_VERSION');if(asset.raster.role==='native'&&(plan.kind!=='decoded-native'||canonical(plan.conversion)!==canonical(asset.raster.conversion)||canonical(asset.raster.sourceAssetIds)!==canonical([plan.sourceAssetId])))throw new Error();
      if(asset.raster.role==='derived'){const source=this.assets.asset((plan as DecodedDerivedPlan).sourceAssetId);if(!source)throw Error('IMPORT_ORIGINAL_MISSING');validateDerivedImportEdge(asset,manifest,source);}
      if(asset.raster.role==='export'){
        if(!['frozen-png-export','frozen-image-export-v1','candidate-lettering-comparison-v1'].includes(String(plan.kind)))throw Error('EXPORT_PLAN');
        const format=plan.kind==='frozen-png-export'||plan.kind==='candidate-lettering-comparison-v1'?'png':(plan.options as {format:string}).format;
        if(asset.qualification!==(format==='jpeg'?'canonical-jpeg':'canonical-png'))throw Error('EXPORT_FORMAT');
      }
      if(plan.kind==='candidate-lettering-comparison-v1'){
        const sourceIds=[...new Set((plan.layers as import('../../src/protocol/raster.js').RasterLayer[]).flatMap(layer=>[layer.assetId,...(layer.mask?[layer.mask.assetId]:[])]))];
        if(asset.qualification!=='canonical-png'||asset.raster.role!=='export'||plan.preservation!=='not-applied'||canonical(asset.raster.sourceAssetIds)!==canonical(sourceIds))throw Error('LETTERING_COMPARISON_ROLE');
        const sources=sourceIds.map(id=>this.assets.asset(id));if(sources.some(source=>!source?.raster||source.qualification!=='canonical-raster'||source.safety!=='safe'||source.availability!=='available')||canonical(sources.map(source=>canonical(source!.raster!.manifest)).sort())!==canonical(manifest.dependencies.map(ref=>canonical(ref)).sort()))throw Error('LETTERING_COMPARISON_DEPENDENCIES');
      }
      for(const ref of [manifest.pixels,...manifest.dependencies,...this.contributionRefs(manifest)]){const registered=this.db.prepare('SELECT byte_length FROM objects WHERE hash=?').get(ref.hash);if(!registered||registered.byte_length!==ref.byteLength||!this.db.prepare('SELECT hash FROM roots WHERE hash=?').get(ref.hash))throw new Error();}
    }catch(e){if(e instanceof StoreError)throw e;throw new StoreError('CORRUPT_STORE');}return manifest;
  }
  async sample(id:string,x:number,y:number){
    const a=this.asset(id,true),info=a.raster!;
    if(info.role==='mask'||!Number.isSafeInteger(x)||!Number.isSafeInteger(y)||x<0||y<0||x>=info.width||y>=info.height)throw new StoreError('MALFORMED_REQUEST');
    const token=await this.objects.prove(info.pixels,()=>this.check());
    try{this.objects.proven(info.pixels,token);const rgba=[...this.objects.readRange(info.pixels,String((y*info.width+x)*4),4)];this.objects.proven(info.pixels,token);return {assetId:id,pixelIdentity:info.pixelIdentity,x,y,rgba,color:'sRGB' as const};}finally{this.objects.releaseProof(token);}
  }
  private approval(body:Extract<RasterBody,{type:'ApproveRaster'}>,auth:AssetAuth):Asset {
    const a=this.asset(body.assetId);this.owner(a.id,auth.clientId);
    if(a.qualification!=='raster-preview'||!a.raster||!['native','derived'].includes(a.raster.role))throw new AssetRejection('INCOMPATIBLE','RASTER_PREVIEW_REQUIRED');
    let review:RasterReview;try{review=this.review(body.reviewId,auth);}catch{throw new AssetRejection('INVALID_INPUT','RASTER_REVIEW_EXPIRED');}
    if(review.reviewHash!==body.reviewHash||review.assetId!==a.id||review.manifestHash!==a.raster.manifest.hash||review.pixelIdentity!==a.raster.pixelIdentity)throw new AssetRejection('STALE_REVISION','RASTER_REVIEW_CHANGED');
    return a;
  }
  private approvalAuthority(id:string):AssetAuth {
    // Live session authority is intentionally not restored across writer epochs.
    // The original durable command survives, but an old review cannot approve.
    const saved=this.approvalAuth.get(id);
    if(!saved)throw new AssetRejection('INVALID_INPUT','RASTER_REVIEW_EXPIRED');
    const auth={...saved.auth,now:saved.auth.now+Math.floor(performance.now()-saved.started)};
    const binding=this.db.prepare('SELECT client_id,expires FROM client_bindings WHERE cookie_hash=?').get(auth.sessionHash);
    if(auth.now>=auth.expires||!binding||binding.client_id!==auth.clientId||auth.now>=Number(binding.expires))throw new AssetRejection('INVALID_INPUT','RASTER_REVIEW_EXPIRED');
    return auth;
  }
  command(bytes:Uint8Array,auth:AssetAuth):Receipt|null{
    this.check();const request=parseCommand(bytes),c=request.command,body=c.body,serialized=canonical(request),hash=hashBytes(serialized);if(c.clientId!==auth.clientId)throw new StoreError('OWNER_REQUIRED');
    const previous=this.db.prepare('SELECT hash,receipt FROM commands WHERE id=?').get(c.commandId);if(previous){if(previous.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');if(this.retainedImportCleanup.has(c.commandId)&&this.runningId!==c.commandId&&!this.cleanupImport(c.commandId))throw new StoreError('CAPACITY');return JSON.parse(String(previous.receipt));}
    if(this.db.prepare('SELECT id FROM history_preparations WHERE id=?').get(c.commandId))throw new StoreError('COMMAND_ID_REUSE');
    const foreign=this.assets.pending(c.commandId);if(foreign){if(foreign.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');throw new StoreError('CORRUPT_STORE');}
    const pending=this.pending(c.commandId);if(pending&&pending.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');
    if(body.type==='ApproveRaster'){
      try{this.approval(body,auth);}catch(e){if(e instanceof AssetRejection){this.approvalAuth.delete(c.commandId);return this.commit(bytes,()=>{throw e;});}throw e;}
    }
    if(pending){if(this.retainedImportCleanup.has(c.commandId)&&this.runningId!==c.commandId&&!this.cleanupImport(c.commandId))throw new StoreError('CAPACITY');if(body.type==='ApproveRaster'||body.type==='InspectRasterOriginal'||body.type==='PrepareRaster'&&body.importPlan)this.approvalAuth.set(c.commandId,{auth:{...auth},started:performance.now()});this.paused.delete(c.commandId);this.schedule(true);return null;}
    if(body.type==='ReviewRaster')return this.commit(bytes,()=>{
      const a=this.asset(body.assetId);this.owner(a.id,auth.clientId);if(a.qualification!=='raster-preview'||!a.raster)throw new AssetRejection('INCOMPATIBLE','RASTER_PREVIEW_REQUIRED');
        const value={protocolVersion:1 as const,reviewId:randomUUID(),assetId:a.id,manifestHash:a.raster.manifest.hash,pixelIdentity:a.raster.pixelIdentity,targetClientId:auth.clientId,expiresAt:new Date(Math.min(auth.expires,auth.now+1800000)).toISOString(),conversion:a.raster.conversion,previewAssetId:a.id,...(a.raster.role==='derived'?{derivation:this.assetManifest(a).plan as DecodedDerivedPlan}:{})};
        const review={...value,reviewHash:hashBytes(canonical(value))};this.db.prepare('INSERT INTO raster_reviews VALUES (?,?,?,?)').run(review.reviewId,canonical(review),auth.sessionHash,this.epoch);return {type:'RasterReviewPrepared',payload:{reviewId:review.reviewId,reviewHash:review.reviewHash}};
    });
    if(!['InspectRasterOriginal','PrepareV45EditInputs','PrepareMask','PrepareRequestMask','PrepareRaster','ApproveRaster','ComposeRaster','ExportRaster'].includes(body.type))throw new StoreError('UNSUPPORTED_COMMAND');
    if(body.type==='PrepareRaster'||body.type==='InspectRasterOriginal')this.owner(body.assetId,auth.clientId);
    if(Number(this.db.prepare('SELECT (SELECT count(*) FROM raster_preparations)+(SELECT count(*) FROM asset_preparations)+(SELECT count(*) FROM history_preparations)+(SELECT count(*) FROM portable_preparations) AS n').get()!.n)>=64){this.approvalAuth.delete(c.commandId);throw new StoreError('QUEUE_FULL');}
    this.transaction(()=>{if(this.db.prepare('SELECT hash FROM asset_preparations WHERE id=?').get(c.commandId))throw new StoreError('COMMAND_ID_REUSE');this.db.prepare('INSERT INTO raster_preparations VALUES (?,?,?,?,?,?)').run(c.commandId,hash,Buffer.from(bytes).toString('utf8'),serialized,randomUUID(),'preparing');this.barrier(body.type==='ApproveRaster'?'raster-approval-preparation-before-commit':'raster-preparation-before-commit');});
    if(body.type==='InspectRasterOriginal'||body.type==='PrepareRaster'&&body.importPlan)this.approvalAuth.set(c.commandId,{auth:{...auth},started:performance.now()});
    if(body.type==='ApproveRaster'){this.approvalAuth.set(c.commandId,{auth:{...auth},started:performance.now()});this.barrier('raster-approval-preparation-after-commit');}
    this.barrier('raster-preparation-after-commit');this.schedule(true);return null;
  }
  schedule(retry=false){if(this.closing||this.running)return;setImmediate(()=>{
    if(this.closing||this.running||this.documentBusy)return;const rows=this.db.prepare("SELECT id FROM raster_preparations WHERE phase='preparing' OR ? ORDER BY id LIMIT 64").all(retry?1:0);
    const row=rows.find(r=>!this.paused.has(String(r.id)));if(!row)return;const id=String(row.id),slot='raster:'+id;
    try{this.objects.acquire(slot);}catch{return;}
    const releaseCoverage=adapterResources.uncovered('raster-preparation');
    this.runningId=id;this.running=adapterResources.scope('raster-prepare',()=>this.prepare(id,slot)).catch(()=>{this.paused.add(id);try{this.transaction(()=>this.db.prepare("UPDATE raster_preparations SET phase='waiting-for-resources' WHERE id=?").run(id));}catch{}}).finally(()=>{this.running=undefined;this.runningId=undefined;this.reservedCPU=0;if(!this.retainedImportCleanup.has(id)){this.objects.unreserve(slot);this.objects.release(slot);}this.retireTerminalImport(id);releaseCoverage();this.schedule();});
  });}
  private async prepare(id:string,slot:string){
    const started=performance.now(),pending=this.pending(id);if(!pending)return;const row=this.db.prepare('SELECT original FROM raster_preparations WHERE id=?').get(id)!,bytes=Buffer.from(String(row.original)),body=pending.command.body;
    const proofs:{ref:BlobRef;token:string}[]=[];
    let requestDocument:string|undefined,derivedInspection:RasterImportInspection|undefined;
    const check=()=>{this.check();if(this.closing)throw new StoreError('CLOSED');if(['InspectRasterOriginal','PrepareRaster'].includes(body.type)&&this.db.prepare('SELECT 1 FROM commands WHERE id=?').get(id))throw new AssetRejection('INVALID_INPUT','RASTER_IMPORT_CANCELED');if(requestDocument&&this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(requestDocument))throw new AssetRejection('STALE_REVISION','DOCUMENT_DELETED');};
    const inputIdentities=new Map<string,string>();
    const capture=(a:Asset)=>{
      const identity=canonical(a),previous=inputIdentities.get(a.id);
      if(previous!==undefined&&previous!==identity)throw new AssetRejection('STALE_REVISION','RASTER_DEPENDENCY_CHANGED');
      inputIdentities.set(a.id,identity);if(inputIdentities.size>512)throw new StoreError('CAPACITY');return a;
    };
    const inputsUnchanged=()=>{
      check();
      for(const [assetId,identity]of inputIdentities)if(canonical(this.assets.asset(assetId))!==identity)throw new AssetRejection('STALE_REVISION','RASTER_DEPENDENCY_CHANGED');
    };
    try{
      if(body.type==='PrepareV45EditInputs'){await this.prepareV45Edit(bytes,pending.operationId,id,body,slot);return;}
      if(body.type==='PrepareRequestMask'){
        // Establish the owning document before the first asynchronous proof.
        // The raw verified manifest remains readable during deletion's GC
        // interval even after its graph roots have intentionally been released.
        const source=capture(this.asset(body.sourceAssetId,true));let value:RasterManifest;
        try{value=parseControlJSON(this.objects.verify(source.raster!.manifest,true)!) as RasterManifest;validateManifest(value);}catch(e){if(e instanceof StoreError&&!['MISSING_OBJECT','CORRUPT_OBJECT','CORRUPT_STORE'].includes(e.code))throw e;throw new AssetRejection('MISSING_ASSET','REQUEST_SOURCE_CAPTURE_UNAVAILABLE');}
        const plan=value.plan as {kind:string;capture:RequestSourceCapture};if(plan.kind!=='request-source-capture-v1')throw new AssetRejection('INCOMPATIBLE','REQUEST_SOURCE_CAPTURE_REQUIRED');
        validateRequestSourceCapture(plan.capture);requestDocument=plan.capture.documentId;check();
      }
      const protect=async(ref:BlobRef)=>{if(proofs.some(p=>canonical(p.ref)===canonical(ref)))return;proofs.push({ref,token:await this.objects.prove(ref,check)});};
      if(body.type==='InspectRasterOriginal'){
        const a=capture(this.asset(body.assetId));if(a.qualification!=='pending-decoder'||a.purpose!=='image')throw new AssetRejection('INCOMPATIBLE','RASTER_ORIGINAL_REQUIRED');await protect(a.blob);
        const metadata=await inspectRasterOriginal(this.objects.path(a.blob),a.measuredMediaType,async plan=>{
          check();const baseline=process.memoryUsage().rss+this.externalCPU();if(!Number.isSafeInteger(plan.cpuBytes)||plan.cpuBytes<0||baseline+plan.cpuBytes>512*1024*1024)throw new StoreError('CAPACITY');this.objects.reserve(slot,BigInt(plan.diskBytes));this.reservedCPU=plan.cpuBytes;
        },check,importProducerAvailable).catch(error=>{
          if(error instanceof Error&&error.message==='RASTER_RESOURCES')throw new StoreError('CAPACITY');
          if(error instanceof Error&&/^RASTER_[A-Z0-9_]+$/.test(error.message)&&!['RASTER_IO','RASTER_SCRATCH_CLEANUP'].includes(error.message))throw new AssetRejection('INVALID_INPUT',error.message);
          throw error;
        });
        const prepared=this.imports.prepare(pending.operationId,a.id,metadata,this.importAuthority(id));
        this.barrier('raster-import-inspection-before-commit');this.commit(bytes,()=>{check();inputsUnchanged();for(const p of proofs)this.objects.proven(p.ref,p.token);const fact=prepared.commit(this.importAuthority(id));this.db.prepare('DELETE FROM raster_preparations WHERE id=?').run(id);return fact;},undefined,slot);return;
      }
      if(body.type==='ApproveRaster'){
        // One shared IO slot, one reusable 1 MiB hash buffer per proof, at most
        // 512 bounded proof records. No raster worker or pixel copies/decodes.
        const reservation=8*1024*1024;if(process.memoryUsage().rss+this.externalCPU()+reservation>512*1024*1024)throw new StoreError('CAPACITY');this.reservedCPU=reservation;
        const a=capture(this.approval(body,this.approvalAuthority(id)));
        try{
          await protect(a.raster!.manifest);const manifest=this.assetManifest(a);
          const refs=[a.blob,a.raster!.pixels,...a.dependencies,...manifest.dependencies];
          for(const sourceId of a.raster!.sourceAssetIds){const source=capture(this.asset(sourceId));refs.push(source.blob,...source.dependencies);}
          for(const ref of refs){check();if(process.memoryUsage().rss>512*1024*1024)throw new StoreError('CAPACITY');await protect(ref);}
          this.barrier('raster-approval-after-proofs');
          // Let queued session renewal/revocation messages reach the writer
          // before checking the live binding and committing without awaits.
          await new Promise<void>(resolve=>setImmediate(resolve));check();
          this.commit(bytes,()=>{
            this.approval(body,this.approvalAuthority(id));
            for(const p of proofs)this.objects.proven(p.ref,p.token);
            this.barrier('raster-approval-before-register');
            for(const p of proofs)this.objects.proven(p.ref,p.token);
            inputsUnchanged();
            const accepted:Asset={...a,id:pending.operationId,qualification:'canonical-raster'};
            const registered=new Set<string>();for(const p of proofs){if(registered.has(p.ref.hash))continue;registered.add(p.ref.hash);this.register('asset:'+accepted.id,p.ref,p.token);}
            this.db.prepare('DELETE FROM raster_preparations WHERE id=?').run(id);
            return {type:'AssetRegistered',payload:{asset:accepted}};
          });
          this.barrier('raster-approval-after-register');return;
        }catch(error){
          const code=(error as {code?:string})?.code;
          if(code==='ENOENT'||code==='MISSING_OBJECT')throw new AssetRejection('MISSING_ASSET','RASTER_DEPENDENCY_MISSING');
          if(code==='CORRUPT_OBJECT'||code==='ROOT_UNSAFE')throw new AssetRejection('MISSING_ASSET','RASTER_DEPENDENCY_CORRUPT');
          throw error;
        }
      }
      const directory=join(this.directory,(body.type==='PrepareRaster'?'import-'+id+'.':'')+randomUUID());
      if(body.type==='PrepareRaster')this.db.prepare('INSERT INTO deletion_work VALUES (?,?)').run(directory,'raster-import:'+id);
      privateDirectory(directory);let job:RasterJob;
      if(body.type==='PrepareRaster'){
        const a=capture(this.asset(body.assetId));if(a.qualification!=='pending-decoder'||!['image','mask'].includes(a.purpose))throw new AssetRejection('INCOMPATIBLE','RASTER_ORIGINAL_REQUIRED');
        await protect(a.blob);
        if(body.importPlan){
          derivedInspection=this.importPlan(a.id,body,id);const transport=derivedInspection.capabilities[body.importPlan.operation.kind],profile=ACTIVE_IMPORT_PROFILES.find(p=>p.baseCodec===IMPORT_BASE_CODEC_ID&&p.producer.transport===transport&&p.platform===process.platform&&p.arch===process.arch);
          if(!profile||!await importProducerAvailable(profile))throw new AssetRejection('INCOMPATIBLE','BOUNDED_DECODER_UNQUALIFIED');check();
          const plan:DecodedDerivedPlan={kind:'decoded-derived-v1',sourceAssetId:a.id,original:a.blob,inspectionHash:derivedInspection.inspectionHash,encoded:derivedInspection.encoded,orientation:derivedInspection.orientation,profile:derivedInspection.profile,profileHash:derivedInspection.profileHash,operation:body.importPlan.operation,kernel:profile.kernel,codec:profile.codec,decodeTransport:profile.producer.transport,decoderSource:profile.producer.sourceHash,...(profile.producer.artifactHash?{decoderBuild:profile.producer.artifactHash,decoderABI:profile.producer.abiVersion!}:{})};
          job={type:'derive-original',directory,path:this.objects.path(a.blob),pipeline:profile.pipeline,plan};
        }else job={type:'decode',directory,path:this.objects.path(a.blob),mediaType:a.measuredMediaType,original:a.blob,sourceAssetId:a.id};
      }else{
        const ids=body.type==='PrepareMask'?maskImports(body.plan):body.type==='PrepareRequestMask'?[...new Set([...maskImports(body.plan),body.sourceAssetId])]:body.type==='ComposeRaster'?[...new Set(body.layers.flatMap(l=>[l.assetId,...(l.mask?[l.mask.assetId]:[])]))]:body.type==='ExportRaster'?[body.assetId]:[];
        const inputs:InputRaster[]=[],dependencies:BlobRef[]=[];
        for(const assetId of ids){const a=capture(this.asset(assetId,true));const info=a.raster!;await protect(info.pixels);await protect(info.manifest);const mask=info.role==='mask'?this.assetManifest(a).plan as {effective:BlobRef;hard:BlobRef}:undefined;for(const ref of [...a.dependencies,...(mask?[mask.hard,mask.effective]:[])])await protect(ref);inputs.push({id:assetId,info,path:this.objects.path(info.pixels),...(mask?{coveragePath:this.objects.path(mask.effective),hardPath:this.objects.path(mask.hard)}:{})});dependencies.push(info.manifest);if(body.type==='PrepareMask'||body.type==='PrepareRequestMask'){try{maskSource(body.plan,assetId,info,mask?.hard);}catch{throw new AssetRejection('INCOMPATIBLE','MASK_BASELINE_IDENTITY');}}}
        if(body.type==='PrepareMask'||body.type==='PrepareRequestMask'){
          for(const input of inputs)if(body.plan.operations.some(op=>op.kind==='import'&&op.assetId===input.id)){const source=this.assets.asset(input.info.sourceAssetIds[0]);if(!source||capture(source).measuredMediaType!=='image/png')throw new AssetRejection('INCOMPATIBLE','MASK_IMPORT_PNG_REQUIRED');}
          let request:Extract<RasterJob,{type:'mask'}>['request'];if(body.type==='PrepareRequestMask'){
            const source=inputs.find(i=>i.id===body.sourceAssetId)!,sourcePlan=this.manifest(source.id).plan as {kind:string;capture:RequestSourceCapture};
            if(sourcePlan.kind!=='request-source-capture-v1'||source.info.width!==body.plan.width||source.info.height!==body.plan.height)throw new AssetRejection('INCOMPATIBLE','REQUEST_SOURCE_CAPTURE_REQUIRED');validateRequestSourceCapture(sourcePlan.capture);
            if(this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(sourcePlan.capture.documentId))throw new AssetRejection('STALE_REVISION','DOCUMENT_DELETED');
            if(body.clip&&(![body.clip.x,body.clip.y,body.clip.width,body.clip.height].every(Number.isSafeInteger)||body.clip.x<0||body.clip.y<0||body.clip.width<=0||body.clip.height<=0||body.clip.x+body.clip.width>body.plan.width||body.clip.y+body.clip.height>body.plan.height))throw new AssetRejection('INVALID_INPUT','REQUEST_MASK_CLIP');
            requestDocument=sourcePlan.capture.documentId;request={source,clip:body.clip};dependencies.push(source.info.pixels);this.db.prepare('INSERT INTO deletion_work VALUES (?,?)').run(directory,requestDocument);
          }
          job={type:'mask',directory,plan:body.plan,inputs,dependencies,...(request?{request}:{})};
        }
        else if(body.type==='ComposeRaster')job={type:'compose',directory,width:body.width,height:body.height,layers:body.layers,inputs,dependencies};
        else if(body.type==='ExportRaster')job={type:'export',directory,input:inputs[0],dependencies,...(body.options?{options:body.options}:{})};else throw new StoreError('UNSUPPORTED_COMMAND');
      }
      //512 bounded proof records cover100 distinct image+mask pairs and outputs.
      // No decoded input surface is retained for each layer.
      const result=await this.compute(job,slot,check,{commandId:pending.command.commandId,documentId:pending.command.documentId??undefined,revision:pending.command.expectedDocumentRevision??undefined,transactionId:pending.command.transactionId,outputAssetId:pending.operationId});this.barrier('raster-after-worker');
      validateManifest(result.manifest);
      if(hashBytes(canonical(result.manifest))!==result.info.manifest.hash||canonical(result.manifest.pixels)!==canonical(result.info.pixels))throw new StoreError('CORRUPT_OBJECT');
      for(const p of proofs)this.objects.proven(p.ref,p.token);
      for(const file of result.files){check();proofs.push({ref:file.ref,token:await this.objects.adoptFile(join(directory,file.name),file.ref,check)});}
      this.barrier('raster-before-register');
      this.commit(bytes,()=>{
        for(const p of proofs)this.objects.proven(p.ref,p.token);
        // File proofs bind bytes, not the records that authorized their use.
        // Recheck the captured records after the late barrier, in this commit.
        inputsUnchanged();if(body.type==='PrepareRaster'&&body.importPlan&&canonical(this.importPlan(body.assetId,body,id))!==canonical(derivedInspection))throw new AssetRejection('STALE_REVISION','RASTER_IMPORT_INSPECTION_CHANGED');
        const a:Asset={id:pending.operationId,version:'1',purpose:'image',blob:result.png,dependencies:[result.info.manifest,result.info.pixels,...result.files.filter(f=>!['pixels.rgba','manifest.json','output.png','output.jpeg'].includes(f.name)).map(f=>f.ref)],safety:'safe',availability:'available',qualification:body.type==='PrepareRaster'?'raster-preview':body.type==='ExportRaster'?(result.png.mediaType==='image/jpeg'?'canonical-jpeg':'canonical-png'):'canonical-raster',measuredMediaType:result.png.mediaType as 'image/png'|'image/jpeg',raster:result.info};
        validateAsset(a);const refs=new Set<string>();for(const p of proofs){if(refs.has(p.ref.hash))continue;refs.add(p.ref.hash);this.register(requestDocument?'request-mask:'+requestDocument+':'+a.id:'asset:'+a.id,p.ref,p.token);}
        this.db.prepare('DELETE FROM raster_preparations WHERE id=?').run(id);return {type:'AssetRegistered',payload:{asset:a}};
      });this.barrier('raster-after-register');
      this.observations.add({commandId:id,operationId:pending.operationId,...result.metrics,fullPreparationMs:performance.now()-started,plan:result.plan,externalEffects:0});
    }catch(error){
      this.observations.add({commandId:id,phase:'failure',code:error instanceof StoreError?error.code:error instanceof AssetRejection?error.reason:'UNEXPECTED',message:error instanceof Error?error.message:'unknown'});
      if(error instanceof AssetRejection)this.commit(bytes,()=>{throw error;},undefined,slot);
      else{const e=safeError(error);if(e.code!=='CLOSED'){this.paused.add(id);this.transaction(()=>this.db.prepare("UPDATE raster_preparations SET phase='waiting-for-resources' WHERE id=?").run(id));}}
    }finally{try{for(const p of proofs)this.objects.releaseProof(p.token);if(body.type==='PrepareRaster')try{if(!this.cleanupImport(id))throw new StoreError('CAPACITY');}catch(error){this.retainedImportCleanup.add(id);this.observations.add({commandId:id,phase:'import-cleanup-retained',slot});throw error;}}finally{this.retireTerminalImport(id);}}
  }
  /** Retained originals, text/K metadata and provider derivatives are one bounded graph. */
  private v45InputGraph(assetIds:readonly string[],extra:readonly BlobRef[]=[],observe?:(asset:Asset)=>void):BlobRef[]{
    const refs=new Map<string,BlobRef>(),assets=new Set<string>(),metadata=new Set<string>(),assetQueue=[...assetIds],metadataQueue:BlobRef[]=[];
    const add=(ref:BlobRef,inspect=false)=>{validateBlob(ref);if(ref.byteLength.length>20)throw new StoreError('CAPACITY');const key=canonical(ref);if(!refs.has(key)&&refs.size>=2048)throw new StoreError('CAPACITY');refs.set(key,ref);if(inspect&&!metadata.has(key)){metadata.add(key);metadataQueue.push(ref);}};
    for(const ref of extra)add(ref,ref.mediaType==='application/json');
    while(assetQueue.length||metadataQueue.length){this.check();
      while(assetQueue.length){const id=assetQueue.shift()!;if(assets.has(id))continue;assets.add(id);if(assets.size>512)throw new StoreError('CAPACITY');const asset=this.assets.asset(id);if(!asset||asset.availability!=='available')throw new AssetRejection('MISSING_ASSET','V45_EDIT_DEPENDENCY_MISSING');observe?.(asset);
        add(asset.blob);for(const ref of asset.dependencies)add(ref);if(asset.retainedMetadata)add(asset.retainedMetadata,true);
        if(asset.raster){add(asset.raster.manifest,true);add(asset.raster.pixels);assetQueue.push(...asset.raster.sourceAssetIds);
          // Only the live asset's capture/lineage resolves local asset IDs.
          // Prior namespace metadata is byte provenance, never lookup authority.
          const current=parseControlJSON(this.objects.verify(asset.raster.manifest,true)!) as RasterManifest;validateManifest(current);const capture=current.plan as {kind:string;capture?:RequestSourceCapture;lineage?:BlobRef};
          if(capture.kind==='request-source-capture-v1'&&capture.capture){if(capture.capture.image.compositeAssetId)assetQueue.push(capture.capture.image.compositeAssetId);const state=parseControlJSON(this.objects.verify(capture.capture.image.state,true)!);imageState(state);for(const layer of state.layers){assetQueue.push(layer.assetId);if(layer.mask)assetQueue.push(layer.mask.assetId);}}
          if(capture.kind==='retained-candidate-v1'&&capture.lineage){const lineage=parseControlJSON(this.objects.verify(capture.lineage,true)!);lineageRecord(lineage);assetQueue.push(...lineageAssetIds(lineage));}
        }
        if(asset.font){add(asset.font.bytes);add(asset.font.licenseRecord);}
      }
      while(metadataQueue.length){const ref=metadataQueue.shift()!;if(ref.mediaType!=='application/json'||BigInt(ref.byteLength)>65536n)throw new StoreError('CORRUPT_OBJECT');const bytes=this.objects.verify(ref,true)!,value=parseControlJSON(bytes);if(canonical(value)!==Buffer.from(bytes).toString('utf8'))throw new StoreError('CORRUPT_OBJECT');
        const dependencies=retainedMetadataReferences(value); // The enclosing ImageState/lineage is validated first.
        const composition=retainedCompositionReference(value);
        for(const dependency of dependencies){
          if(dependency.inspect&&composition&&canonical(dependency.ref)===canonical(composition.value)){
            add(dependency.ref);
            this.compositionMemory.compositions([composition],()=>{
              const graph=readComposition(composition,historyCompositionReader(this.objects,[composition]));
              for(const leaf of compositionRefs(graph))add(leaf); // Exact authored bytes are opaque leaves.
            });
          }else add(dependency.ref,dependency.inspect);
        }
      }
    }
    return [...refs.values()];
  }
  private v45Source(source:Source):{asset:Asset;manifest:RasterManifest;documentId:string}{
    const asset=this.asset(source.assetId,true),info=asset.raster!;
    if(info.role==='mask'||asset.version!==source.version||canonical(asset.blob)!==canonical(source.blob)||canonical(info.pixels)!==canonical(source.pixels)||info.width!==source.width||info.height!==source.height||!source.capture||canonical(info.manifest)!==canonical(source.capture))throw new AssetRejection('STALE_REVISION','V45_EDIT_SOURCE_CHANGED');
    const manifest=this.assetManifest(asset),plan=manifest.plan as {kind:string;capture:RequestSourceCapture};
    if(plan.kind!=='request-source-capture-v1')throw new AssetRejection('INCOMPATIBLE','REQUEST_SOURCE_CAPTURE_REQUIRED');validateRequestSourceCapture(plan.capture);
    if(plan.capture.scope!==source.scope||plan.capture.documentRevision!==source.documentRevision)throw new AssetRejection('STALE_REVISION','V45_EDIT_SOURCE_CHANGED');
    return {asset,manifest,documentId:plan.capture.documentId};
  }
  /** Preserve an imported/stale draft's immutable bytes without renewing input authority. */
  v45EditInputReferences(assetId:string){
    return this.compositionMemory.referenceCollection(()=>this.v45EditInputReferencesValue(assetId));
  }
  private v45EditInputReferencesValue(assetId:string):BlobRef[]{
    const asset=this.asset(assetId,true),manifest=this.assetManifest(asset),plan=manifest.plan as V45EditInputsPlan;v45EditInputsPlan(plan);
    const ids=[...new Set([plan.assetBindings.source,...(plan.assetBindings.mask?[plan.assetBindings.mask]:[]),...plan.assetBindings.references])];if(canonical(asset.raster!.sourceAssetIds)!==canonical(ids))throw new StoreError('CORRUPT_OBJECT');
    return this.v45InputGraph(ids,[asset.blob,asset.raster!.manifest,asset.raster!.pixels,...v45EditInputsReferences(plan)]);
  }
  /** Returns only accepted descriptors. Imported authoring identities require explicit recapture. */
  v45EditInputs(assetId:string){
    return this.compositionMemory.referenceCollection(()=>this.v45EditInputsValue(assetId));
  }
  private v45EditInputsValue(assetId:string):V45EditInputs{
    const asset=this.asset(assetId,true),manifest=this.assetManifest(asset),plan=manifest.plan as V45EditInputsPlan;v45EditInputsPlan(plan);
    if(plan.assetBindings.source!==plan.original.source.assetId||plan.assetBindings.mask!==(plan.original.mask?.assetId??null)||plan.assetBindings.references.some((id,i)=>id!==plan.references[i].original.assetId))throw new AssetRejection('STALE_REVISION','V45_EDIT_INPUTS_RECAPTURE_REQUIRED');
    const read=(ref:BlobRef)=>{const bytes=this.objects.verify(ref,true)!,value=parseControlJSON(bytes);validateManifest(value);if(canonical(value)!==Buffer.from(bytes).toString('utf8'))throw new StoreError('CORRUPT_OBJECT');return value as RasterManifest;};
    const original=this.v45Source(plan.original.source),base=read(plan.input),same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
    if(!same(base.pixels,manifest.pixels)||base.pipeline!==manifest.pipeline||!same(base.tiles,manifest.tiles))throw new StoreError('CORRUPT_OBJECT');
    const basePlan=base.plan as any;
    if(plan.requestPlan){if(basePlan.kind!=='request-source-transport-v1'||!same(basePlan.source,original.asset.raster!.manifest)||!same(basePlan.requestPlan,plan.requestPlan))throw new StoreError('CORRUPT_OBJECT');}
    else if(basePlan.kind!=='frozen-png-export'||basePlan.sourceAssetId!==original.asset.id||!same(base.pixels,original.asset.raster!.pixels)||basePlan.pixelIdentity!==original.asset.raster!.pixelIdentity)throw new StoreError('CORRUPT_OBJECT');
    const descriptor=(input:V45PreparedRaster)=>{const m=read(input.manifest);if(input.width!==m.width||input.height!==m.height||!same(input.pixels,m.pixels)||input.pixelIdentity!==hashBytes(canonical({pipeline:m.pipeline,width:m.width,height:m.height,tiles:m.tiles})))throw new StoreError('CORRUPT_OBJECT');return m;};
    if(plan.mask){const originalMask=this.asset(plan.original.mask!.assetId,true),mask=read(plan.original.mask!.plan),m=descriptor(plan.mask),p=m.plan as any;
      if(originalMask.raster!.role!=='mask'||originalMask.version!==plan.original.mask!.version||!same(originalMask.blob,plan.original.mask!.blob)||!same(originalMask.raster!.pixels,plan.original.mask!.pixels)||!same(originalMask.raster!.manifest,plan.original.mask!.plan)||!same((mask.plan as any).hard,plan.requestPlan!.authoredMask)||!same((mask.plan as any).effective,plan.requestPlan!.effectiveMask)||p.kind!=='v45-edit-mask-v1'||!same(p.source,original.asset.raster!.manifest)||!same(p.mask,originalMask.raster!.manifest)||!same(p.sourcePixels,asset.raster!.pixels)||!same(p.requestPlan,plan.requestPlan)||p.statistics.editPixels!==plan.mask.editPixels||p.statistics.keepPixels!==plan.mask.keepPixels)throw new AssetRejection('STALE_REVISION','V45_EDIT_MASK_CHANGED');
    }
    for(const reference of plan.references){const original=this.v45Source(reference.original),m=descriptor(reference.input),p=m.plan as any;if(p.kind!=='frozen-png-export'||p.sourceAssetId!==original.asset.id||!same(m.pixels,original.asset.raster!.pixels)||p.pixelIdentity!==original.asset.raster!.pixelIdentity)throw new StoreError('CORRUPT_OBJECT');}
    const expectedIds=[...new Set([plan.assetBindings.source,...(plan.assetBindings.mask?[plan.assetBindings.mask]:[]),...plan.assetBindings.references])];if(!same(asset.raster!.sourceAssetIds,expectedIds))throw new StoreError('CORRUPT_OBJECT');
    const refs=this.v45InputGraph(expectedIds,[asset.blob,asset.raster!.manifest,asset.raster!.pixels,...v45EditInputsReferences(plan)]);for(const ref of refs)this.objects.readRange(ref,'0',0);
    const source={assetId:asset.id,version:asset.version,blob:asset.blob,pixels:asset.raster!.pixels,manifest:asset.raster!.manifest,pixelIdentity:asset.raster!.pixelIdentity,width:asset.raster!.width,height:asset.raster!.height};
    return {manifest:asset.raster!.manifest,original:plan.original,source,mask:plan.mask,requestPlan:plan.requestPlan,references:plan.references,refs};
  }
  private async prepareV45Edit(bytes:Uint8Array,operationId:string,commandId:string,body:V45EditPreparation,slot:string){
    const proofs:{ref:BlobRef;token:string}[]=[],identities=new Map<string,string>(),documents=new Set<string>(),started=performance.now();
    const capture=(asset:Asset)=>{const identity=canonical(asset),prior=identities.get(asset.id);if(prior!==undefined&&prior!==identity)throw new AssetRejection('STALE_REVISION','V45_EDIT_DEPENDENCY_CHANGED');identities.set(asset.id,identity);};
    const check=()=>{this.check();if(this.closing)throw new StoreError('CLOSED');for(const id of documents)if(this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(id))throw new AssetRejection('STALE_REVISION','DOCUMENT_DELETED');};
    const unchanged=()=>{check();for(const [id,identity]of identities)if(canonical(this.assets.asset(id))!==identity)throw new AssetRejection('STALE_REVISION','V45_EDIT_DEPENDENCY_CHANGED');};
    const protect=async(ref:BlobRef)=>{if(!proofs.some(p=>canonical(p.ref)===canonical(ref)))proofs.push({ref,token:await this.objects.prove(ref,check)});};
    try{
      try{v45EditPreparation(body);}catch{throw new AssetRejection('INVALID_INPUT','V45_EDIT_INPUTS_INVALID');}
      const original=this.v45Source(body.source),referenceOriginals=body.references.map(source=>this.v45Source(source));
      documents.add(original.documentId);for(const source of referenceOriginals)documents.add(source.documentId);check();
      const requestPlan=body.mask?requireRequestMaskPlan(body.source,body.mask):null,mask=body.mask?this.asset(body.mask.assetId,true):null;
      let maskManifest:RasterManifest|null=null;
      if(mask&&body.mask&&requestPlan){const info=mask.raster!;maskManifest=this.assetManifest(mask);const p=maskManifest.plan as any;
        if(info.role!=='mask'||mask.version!==body.mask.version||canonical(mask.blob)!==canonical(body.mask.blob)||canonical(info.pixels)!==canonical(body.mask.pixels)||canonical(info.manifest)!==canonical(body.mask.plan)||info.width!==body.source.width||info.height!==body.source.height)throw new AssetRejection('STALE_REVISION','V45_EDIT_MASK_CHANGED');
        requireMaskAlignment(body.source,body.mask);requirePlanDependencies(requestPlan,{sourcePixels:body.source.pixels,authoredMask:p.hard,effectiveMask:p.effective,dependenciesHash:requestMaskDependencies(body.source,body.mask),document:{width:body.source.width,height:body.source.height}});
        if(body.mask.binding&&(p.kind!=='authored-request-mask-v1'||p.sourceAssetId!==body.source.assetId||canonical(p.source)!==canonical(body.source.capture)||canonical(p.sourcePixels)!==canonical(body.source.pixels)))throw new AssetRejection('STALE_REVISION','V45_EDIT_MASK_SOURCE_CHANGED');
        if(p.clip!==undefined&&p.clip!==null&&requestPlan.resolution!=='clipped-and-approved')throw new AssetRejection('INVALID_INPUT','MASK_CLIP_REVIEW_REQUIRED');
      }
      const ids=[...new Set([original.asset.id,...(mask?[mask.id]:[]),...referenceOriginals.map(x=>x.asset.id)])];
      const graph=this.compositionMemory.referenceCollection(()=>this.v45InputGraph(ids,[],capture));try{for(const ref of graph.value)await protect(ref);}finally{graph.release();}
      const input=(asset:Asset):InputRaster=>({id:asset.id,info:asset.raster!,path:this.objects.path(asset.raster!.pixels),...(asset===mask&&maskManifest?{coveragePath:this.objects.path((maskManifest.plan as any).effective)}:{})});
      const run=async(value:Omit<Extract<RasterJob,{type:'export'}>,'directory'>|Omit<Extract<RasterJob,{type:'request-source'}>,'directory'>|Omit<Extract<RasterJob,{type:'v45-edit-mask'}>,'directory'>)=>{
        check();const directory=join(this.directory,randomUUID());privateDirectory(directory);this.db.prepare('INSERT INTO deletion_work VALUES (?,?)').run(directory,original.documentId);
        const result=await this.compute({...value,directory} as RasterJob,slot,check,{commandId,documentId:original.documentId,outputAssetId:operationId});validateManifest(result.manifest);
        if(hashBytes(canonical(result.manifest))!==result.info.manifest.hash||canonical(result.manifest.pixels)!==canonical(result.info.pixels))throw new StoreError('CORRUPT_OBJECT');
        for(const file of result.files){check();if(!proofs.some(p=>canonical(p.ref)===canonical(file.ref)))proofs.push({ref:file.ref,token:await this.objects.adoptFile(join(directory,file.name),file.ref,check)});}
        for(const proof of proofs)this.objects.proven(proof.ref,proof.token);unchanged();return result;
      };
      const sourceResult=await run(requestPlan?{type:'request-source',input:input(original.asset),plan:requestPlan,dependencies:[original.asset.raster!.manifest,requestPlan.sourcePixels,requestPlan.authoredMask,requestPlan.effectiveMask]}:{type:'export',input:input(original.asset),dependencies:[original.asset.raster!.manifest]});
      const prepared=(result:RasterResult):V45PreparedRaster=>({blob:result.png,pixels:result.info.pixels,manifest:result.info.manifest,pixelIdentity:result.info.pixelIdentity,width:result.info.width,height:result.info.height});
      let black:V45PreparedBlack|null=null;
      if(mask&&requestPlan){const result=await run({type:'v45-edit-mask',input:input(mask),source:original.asset.raster!.manifest,sourceAssetId:original.asset.id,sourcePixels:sourceResult.info.pixels,plan:requestPlan,dependencies:[original.asset.raster!.manifest,mask.raster!.manifest,sourceResult.info.pixels,requestPlan.sourcePixels,requestPlan.authoredMask,requestPlan.effectiveMask]}),p=result.manifest.plan as any;black={...prepared(result),polarity:'black-edit',sourcePixels:sourceResult.info.pixels,editPixels:p.statistics.editPixels,keepPixels:p.statistics.keepPixels};}
      const references:V45EditInputsPlan['references'][number][]=[];
      for(let i=0;i<referenceOriginals.length;i++){const source=referenceOriginals[i].asset,result=await run({type:'export',input:input(source),dependencies:[source.raster!.manifest]});references.push({original:structuredClone(body.references[i]),input:prepared(result)});}
      const plan:V45EditInputsPlan={kind:'v45-edit-inputs-1',endpoint:'ideogram/v4.5/edit',input:sourceResult.info.manifest,assetBindings:{source:body.source.assetId,mask:body.mask?.assetId??null,references:body.references.map(r=>r.assetId)},original:{source:structuredClone(body.source),mask:structuredClone(body.mask)},mask:black,requestPlan:requestPlan?structuredClone(requestPlan):null,references};
      const manifest:RasterManifest={...sourceResult.manifest,schemaVersion:1,dependencies:v45EditInputsReferences(plan),plan};validateManifest(manifest);
      const manifestRef=this.objects.putMetadataInSlot(Buffer.from(canonical(manifest)),slot);await protect(manifestRef);
      const asset:Asset={id:operationId,version:'1',purpose:'image',blob:sourceResult.png,dependencies:[manifestRef,sourceResult.info.pixels],safety:'safe',availability:'available',qualification:'canonical-raster',measuredMediaType:'image/png',raster:{...sourceResult.info,schemaVersion:1,manifest:manifestRef,role:'composite',sourceAssetIds:ids,conversion:null}};validateAsset(asset);
      this.barrier('v45-edit-inputs-before-register');
      this.commit(bytes,()=>{unchanged();for(const proof of proofs)this.objects.proven(proof.ref,proof.token);const registered=new Set<string>();for(const proof of proofs){if(registered.has(proof.ref.hash))continue;registered.add(proof.ref.hash);this.register('request-mask:'+original.documentId+':'+asset.id,proof.ref,proof.token);}this.db.prepare('DELETE FROM raster_preparations WHERE id=?').run(commandId);return {type:'AssetRegistered',payload:{asset}};});
      this.barrier('v45-edit-inputs-after-register');this.observations.add({commandId,operationId,kind:'v45-edit-inputs-1',fullPreparationMs:performance.now()-started,externalEffects:0});
    }catch(error){
      if(error instanceof RequestError)throw new AssetRejection('INVALID_INPUT',error.issues[0]?.code??'V45_EDIT_INPUTS_INVALID');
      if(error instanceof StoreError&&['MISSING_OBJECT','CORRUPT_OBJECT','CORRUPT_STORE','NOT_FOUND'].includes(error.code))throw new AssetRejection('MISSING_ASSET','V45_EDIT_DEPENDENCY_UNAVAILABLE');
      if(error instanceof Error&&['MASK_MAPPING_REVIEW_REQUIRED','MASK_DOMAIN_REVIEW_REQUIRED','REQUEST_RASTER_APPROVAL_REQUIRED','REQUEST_RASTER_DEPENDENCIES_CHANGED'].includes(error.message))throw new AssetRejection('INVALID_INPUT',error.message);
      if(error instanceof Error&&!(error instanceof StoreError)&&!(error instanceof AssetRejection))throw new AssetRejection('INVALID_INPUT','V45_EDIT_INPUTS_INVALID');
      throw error;
    }finally{for(const proof of proofs)this.objects.releaseProof(proof.token);}
  }
  private retainWorkerPhases(snapshot:RasterWorkerSnapshot|undefined){
    if(!snapshot||snapshot.schemaVersion!==1||snapshot.lane!=='raster-worker'||!Array.isArray(snapshot.records)||snapshot.records.length>64)return;
    this.workerPhases.add(snapshot);
  }
  private async compute(job:RasterJob,slot:string,check:()=>void,context:PhaseContext={}):Promise<RasterResult>{
    // The real worker may be idle/resident, but every job independently proves
    // whole-process headroom and obtains its own output-slot reservation.
    // Ready text and composition jobs reserve their complete operation plans.
    // Pin that native generation: loss rejects; it cannot start a cold replacement
    // under this reservation. Cold workers and other job types keep 128MiB.
    const readyWorker=job.type==='text'||job.type==='compose'?this.workerOwner.readyIdentity:null;
    const warmPlan=readyWorker?(job.type==='text'?retainedTextResourcePlan(job.width,job.height):job.type==='compose'?compositionResourcePlan(job.width,job.height,job.layers,job.inputs,!!job.requestSource):undefined):undefined;
    const preflightCPU=warmPlan?.cpuBytes??128*1024*1024;
    const processRSS=process.memoryUsage().rss,externalCPU=this.externalCPU(),baselineRSS=processRSS+externalCPU;check();
    if(baselineRSS+preflightCPU>512*1024*1024){try{this.observations.add({phase:'resource-preflight',job:job.type,slot,processRSS,externalCPU,preflightCPU,combinedReservedBytes:baselineRSS+preflightCPU,limit:512*1024*1024,admitted:false});}catch{/* Diagnostic pressure cannot replace the original capacity refusal. */}throw new StoreError('CAPACITY');}this.reservedCPU=preflightCPU;
    let planBaselineRSS=baselineRSS,peakRSS=process.memoryUsage().rss,supervisorError:unknown;
    const timer=setInterval(()=>{try{check();peakRSS=Math.max(peakRSS,process.memoryUsage().rss);if(peakRSS+this.externalCPU()>512*1024*1024)throw new StoreError('CAPACITY');this.objects.capacity(0n);}catch(error){supervisorError=error;const flag=this.importCancellations.get(slot);if(flag)Atomics.store(new Uint32Array(flag),0,1);void this.workerOwner.interrupt(slot).catch(()=>{});}},1000);
    try{
      if(job.type==='derive-original'){const cancellation=job.cancellation??new SharedArrayBuffer(4);job={...job,cancellation};this.importCancellations.set(slot,cancellation);}
      const result=await this.workerOwner.run({...job,telemetry:sanitizePhaseContext(context)},slot,{
        check,
        admit:plan=>{
          check();const processRSS=process.memoryUsage().rss,externalCPU=this.externalCPU();planBaselineRSS=processRSS+externalCPU;const combined=planBaselineRSS+plan.cpuBytes;
          const allowed=Number.isSafeInteger(plan.cpuBytes)&&plan.cpuBytes>=0&&combined<=512*1024*1024;
          this.observations.add({phase:'resource-admission',slot,plan,processRSS,externalCPU,replacedCPU:this.reservedCPU,admissionBaselineRSS:planBaselineRSS,combinedReservedBytes:combined,admitted:allowed,worker:this.workerOwner.snapshot.identity});
          if(!allowed)throw new StoreError('CAPACITY');this.objects.reserve(slot,BigInt(plan.diskBytes));this.reservedCPU=plan.cpuBytes;
        },
        telemetry:read=>this.retainWorkerPhases(read.value),
        failure:message=>{
          const remaining=message.resourceFailure?.outputRemaining,outputPeak=message.resourceFailure?.outputPeak;
          const retained=Number.isSafeInteger(remaining)&&Number.isSafeInteger(outputPeak)&&remaining!>0&&remaining!<=outputPeak!&&outputPeak!<=100065536;
          if(retained){this.observations.add({phase:'resource-retained',slot,outputPeak,outputRemaining:remaining,release:'OS unmap failed; retained allocation, not released. Library lease applies only to the loaded instance.'});}
          return retained||message.code==='RASTER_RESOURCES'?new StoreError('CAPACITY'):new AssetRejection('INVALID_INPUT',message.code);
        }
      },readyWorker??undefined);
      if(supervisorError)throw supervisorError;
      result.metrics.supervisorPeakRSS=Math.max(peakRSS,process.memoryUsage().rss);result.metrics.admissionBaselineRSS=planBaselineRSS;result.metrics.combinedReservedBytes=planBaselineRSS+result.plan.cpuBytes;
      result.metrics.workerGeneration=this.workerOwner.snapshot.identity?.generation??0;result.metrics.workerThreadId=this.workerOwner.snapshot.identity?.threadId??0;return result;
    }catch(error){throw supervisorError??error;}finally{this.importCancellations.delete(slot);clearInterval(timer);}
  }
  rasterWorkerState(){this.check();return this.workerOwner.snapshot;}
  /** Owner-process maintenance only. There is no HTTP operation or dummy job. */
  async restartIdleWorker(expectedGeneration:number){
    this.check();if(!this.documentAvailable||this.reservedCPU!==0)throw new StoreError('QUEUE_FULL');const releaseCoverage=adapterResources.uncovered('raster-worker-restart');this.documentBusy=true;
    try{
      const baseline=process.memoryUsage().rss+this.externalCPU(),preflight=128*1024*1024;
      if(baseline+preflight>512*1024*1024)throw new StoreError('CAPACITY');this.reservedCPU=preflight;
      return await this.workerOwner.restartIdle(expectedGeneration);
    }finally{this.reservedCPU=0;this.documentBusy=false;releaseCoverage();this.schedule();}
  }
  /** Display scratch uses the same single-worker admission, without asset registration. */
  async displayWork(job:Extract<RasterJob,{type:'decode'|'export'}>,slot:string,check:()=>void){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');const releaseCoverage=adapterResources.uncovered('raster-display-job');this.documentBusy=true;
    try{return await this.compute(job,slot,check);}
    finally{this.documentBusy=false;this.reservedCPU=0;releaseCoverage();this.schedule();}
  }
  async stopDisplayWork(slot:string){const flag=this.importCancellations.get(slot);if(flag)Atomics.store(new Uint32Array(flag),0,1);await this.workerOwner.interrupt(slot);}
  async validateMaskPortable(plan:import('../../src/raster/mask.js').MaskPlan,inputs:InputRaster[],directory:string,slot:string,check:()=>void,request?:Extract<RasterJob,{type:'mask'}>['request']){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');const releaseCoverage=adapterResources.uncovered('raster-portable-job');this.documentBusy=true;
    try{return await this.compute({type:'mask',plan,inputs,directory,dependencies:[...inputs.map(i=>i.info.manifest),...(request?[request.source.info.pixels]:[])],...(request?{request}:{})},slot,check);}
    finally{this.documentBusy=false;this.reservedCPU=0;releaseCoverage();}
  }
  async validateRequestPreservationPortable(plan:RequestRasterPlan,source:InputRaster,candidate:InputRaster,mask:InputRaster,directory:string,slot:string,check:()=>void,outputMapping?:RequestOutputMapping){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');const releaseCoverage=adapterResources.uncovered('raster-portable-job');this.documentBusy=true;
    try{return await this.compute({type:'preserve-request',plan,source,candidate,mask,directory,dependencies:[source.info.manifest,candidate.info.manifest,mask.info.manifest,plan.sourcePixels,plan.authoredMask,plan.effectiveMask,...(outputMapping?[outputMapping.effectiveMask]:[])],...(outputMapping?{outputMapping}:{})},slot,check);}
    finally{this.documentBusy=false;this.reservedCPU=0;releaseCoverage();}
  }
  async validateV45EditSourcePortable(source:InputRaster,plan:RequestRasterPlan|null,directory:string,slot:string,check:()=>void,replay?:import('../raster/engine.js').RasterReplayIdentity){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');const releaseCoverage=adapterResources.uncovered('raster-portable-job');this.documentBusy=true;
    try{return await this.compute(plan?{type:'request-source',input:source,plan,directory,dependencies:[source.info.manifest,plan.sourcePixels,plan.authoredMask,plan.effectiveMask],...(replay?{replay}:{})}:{type:'export',input:source,directory,dependencies:[source.info.manifest],...(replay?{replay}:{})},slot,check);}
    finally{this.documentBusy=false;this.reservedCPU=0;releaseCoverage();}
  }
  async validateV45EditMaskPortable(plan:RequestRasterPlan,sourceManifest:BlobRef,sourcePixels:BlobRef,mask:InputRaster,directory:string,slot:string,check:()=>void,replay?:import('../raster/engine.js').RasterReplayIdentity){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');const releaseCoverage=adapterResources.uncovered('raster-portable-job');this.documentBusy=true;
    try{return await this.compute({type:'v45-edit-mask',input:mask,source:sourceManifest,sourceAssetId:'portable-validation',sourcePixels,plan,directory,dependencies:[sourceManifest,mask.info.manifest,sourcePixels,plan.sourcePixels,plan.authoredMask,plan.effectiveMask],...(replay?{replay}:{})},slot,check);}
    finally{this.documentBusy=false;this.reservedCPU=0;releaseCoverage();}
  }
  async validateCompositionPortable(width:number,height:number,layers:readonly import('../../src/protocol/raster.js').RasterLayer[],inputs:InputRaster[],directory:string,slot:string,check:()=>void,requestSource?:RequestSourceCapture,replay?:import('../raster/engine.js').RasterReplayIdentity){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');const releaseCoverage=adapterResources.uncovered('raster-portable-job');this.documentBusy=true;
    try{return await this.compute({type:'compose',width,height,layers,inputs,directory,dependencies:[...inputs.map(i=>i.info.manifest),...(requestSource?[requestSource.image.state]:[])],...(requestSource?{requestSource}:{}),...(replay?{replay}:{})},slot,check);}
    finally{this.documentBusy=false;this.reservedCPU=0;releaseCoverage();}
  }
  private cleanupPortableComparisons(){for(const [directory,reservation]of this.portableComparisonScratch){rmSync(directory,{recursive:true,force:true});this.objects.unreserve(reservation);this.portableComparisonScratch.delete(directory);}}
  /** Portable replay verifies review imagery from its retained raw inputs. It
   * deliberately supplies no encoded-rebuild or preservation authority. */
  async validateLetteringComparisonPortable(plan:{sourceWidth:number;sourceHeight:number;layers:readonly import('../../src/protocol/raster.js').RasterLayer[];comparison:LetteringComparison},inputs:InputRaster[],directory:string,slot:string,check:()=>void,replay?:import('../raster/engine.js').RasterReplayIdentity,dependencies:readonly BlobRef[]=inputs.map(input=>input.info.manifest)){
    check();validateEncodedCompositionLayers(plan.sourceWidth,plan.sourceHeight,plan.layers);
    if(!['candidate-alone','native-off','native-on'].includes(plan.comparison)||plan.comparison==='candidate-alone'&&(plan.layers.length!==1||plan.layers[0].opacity!==1||plan.layers[0].mask!==null))throw new AssetRejection('INVALID_INPUT','LETTERING_COMPARISON_REQUIRED');
    const ids=[...new Set(plan.layers.flatMap(layer=>[layer.assetId,...(layer.mask?[layer.mask.assetId]:[])]))];
    if(!Array.isArray(inputs)||inputs.length>200||new Set(inputs.map(input=>input.id)).size!==inputs.length||canonical([...ids].sort())!==canonical(inputs.map(input=>input.id).sort())||canonical(dependencies.map(ref=>canonical(ref)).sort())!==canonical(inputs.map(input=>canonical(input.info.manifest)).sort()))throw new AssetRejection('INVALID_INPUT','LETTERING_COMPARISON_INPUT');
    plan={sourceWidth:plan.sourceWidth,sourceHeight:plan.sourceHeight,layers:structuredClone(plan.layers),comparison:plan.comparison};inputs=structuredClone(inputs);dependencies=structuredClone(dependencies);
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');this.cleanupPortableComparisons();const releaseCoverage=adapterResources.uncovered('raster-portable-job');this.documentBusy=true;
    const scratch=join(directory,'lettering-comparison-'+randomUUID()),reservation=slot+':comparison-scratch:'+randomUUID(),scale=Math.min(1,1024/plan.sourceWidth,1024/plan.sourceHeight),size={width:Math.max(1,Math.round(plan.sourceWidth*scale)),height:Math.max(1,Math.round(plan.sourceHeight*scale))};
    try{
      privateDirectory(scratch);this.objects.reserve(reservation,BigInt(plan.sourceWidth*plan.sourceHeight*12+2*1024*1024));this.portableComparisonScratch.set(scratch,reservation);
      const composed=await this.compute({type:'compose',directory:scratch,width:plan.sourceWidth,height:plan.sourceHeight,layers:plan.layers,inputs,dependencies,...(replay?{replay:{pipeline:replay.pipeline}}:{})},slot,check);check();
      const result=await this.compute({type:'export',directory,input:{id:'lettering-comparison-scratch',info:composed.info,path:join(scratch,'pixels.rgba')},dependencies,options:{format:'png',resize:size,matte:null,quality:null},...(replay?{replay}:{})},slot,check);check();
      const manifest:RasterManifest={...result.manifest,plan:{kind:'candidate-lettering-comparison-v1',sourceWidth:plan.sourceWidth,sourceHeight:plan.sourceHeight,layers:plan.layers,comparison:plan.comparison,kernel:'triangle-area-source-axis-row-norm-v1',edge:'transparent-zero-no-renormalization',preservation:'not-applied'}};validateManifest(manifest);
      const bytes=Buffer.from(canonical(manifest));if(bytes.length>65536)throw new StoreError('CAPACITY');writeFileSync(join(directory,'manifest.json'),bytes,{mode:0o600});const ref=encodedFileRef(join(directory,'manifest.json'),'application/json',check);
      return {...result,manifest,info:{...result.info,manifest:ref,sourceAssetIds:ids},files:result.files.map(file=>file.name==='manifest.json'?{...file,ref}:file),metrics:{...result.metrics,computeMs:composed.metrics.computeMs+result.metrics.computeMs,encodeMs:composed.metrics.encodeMs+result.metrics.encodeMs,comparisonSourceWidth:plan.sourceWidth,comparisonSourceHeight:plan.sourceHeight}};
    }finally{try{rmSync(scratch,{recursive:true,force:true});this.objects.unreserve(reservation);this.portableComparisonScratch.delete(scratch);}finally{this.documentBusy=false;this.reservedCPU=0;releaseCoverage();}}
  }
  async validatePortable(path:string,mediaType:string,original:BlobRef,directory:string,slot:string,check:()=>void){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');const releaseCoverage=adapterResources.uncovered('raster-portable-job');this.documentBusy=true;
    try{return await this.compute({type:'decode',path,mediaType,original,sourceAssetId:'portable-validation',directory},slot,check);}
    finally{this.documentBusy=false;this.reservedCPU=0;releaseCoverage();}
  }
  async validateDerivedPortable(path:string,pipeline:string,plan:DecodedDerivedPlan,directory:string,slot:string,check:()=>void){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');const releaseCoverage=adapterResources.uncovered('raster-portable-job');this.documentBusy=true;
    try{return await this.compute({type:'derive-original',path,pipeline,plan,directory},slot,check);}
    finally{this.documentBusy=false;this.reservedCPU=0;releaseCoverage();}
  }
  async validateExportPortable(input:InputRaster,options:import('../../src/protocol/export.js').RasterExportOptions|undefined,directory:string,slot:string,check:()=>void,encoderTransport?:import('../raster/jpeg.js').JPEGTransport,replay?:import('../raster/engine.js').RasterReplayIdentity){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');const releaseCoverage=adapterResources.uncovered('raster-portable-job');this.documentBusy=true;
    try{return await this.compute({type:'export',input,options,directory,dependencies:[input.info.manifest],...(encoderTransport?{encoderTransport}:{}),...(replay?{replay}:{})},slot,check);}
    finally{this.documentBusy=false;this.reservedCPU=0;releaseCoverage();}
  }
  // Internal document owner uses the SAME worker/admission/pixel pipeline. It
  // publishes the result only in its atomic image/history acceptance transaction.
  get documentAvailable(){return !this.running&&!this.documentBusy&&!this.closing;}
  /** Attach inert request lineage to the exact accepted placement raster. No
   * decode, resampling, PNG encoding, or pixel copy occurs in this operation. */
  async retainCandidate(source:Asset,lineage:BlobRef,id:string,slot:string,check:()=>void){
    if(this.closing)throw new StoreError('CLOSED');
    validateAsset(source);
    if(source.qualification!=='canonical-raster'||source.safety!=='safe'||source.availability!=='available'||!source.raster||source.raster.role==='mask')throw new AssetRejection('INCOMPATIBLE','CANDIDATE_RASTER_UNAVAILABLE');
    const proofs:{ref:BlobRef;token:string}[]=[];
    try{
      for(const ref of [source.blob,source.raster.manifest,source.raster.pixels,lineage])if(!proofs.some(p=>canonical(p.ref)===canonical(ref)))proofs.push({ref,token:await this.objects.prove(ref,check)});
      const originalBytes=this.objects.verify(source.raster.manifest,true)!,original=JSON.parse(Buffer.from(originalBytes).toString('utf8')) as RasterManifest;
      validateManifest(original);
      if(canonical(original)!==Buffer.from(originalBytes).toString('utf8')||original.pipeline!==source.raster.pipeline||original.width!==source.raster.width||original.height!==source.raster.height||canonical(original.pixels)!==canonical(source.raster.pixels)||hashBytes(canonical({pipeline:original.pipeline,width:original.width,height:original.height,tiles:original.tiles}))!==source.raster.pixelIdentity)throw new StoreError('CORRUPT_OBJECT');
      const lineageBytes=this.objects.verify(lineage,true)!,observation=JSON.parse(Buffer.from(lineageBytes).toString('utf8'));lineageRecord(observation);
      if(lineage.mediaType!=='application/json'||canonical(observation)!==Buffer.from(lineageBytes).toString('utf8'))throw new StoreError('CORRUPT_OBJECT');
      const manifest:RasterManifest={...original,schemaVersion:1,dependencies:[source.raster.manifest,lineage],plan:{kind:'retained-candidate-v1',source:source.raster.manifest,lineage}};
      validateManifest(manifest);check();
      const ref=this.objects.putMetadataInSlot(Buffer.from(canonical(manifest)),slot);proofs.push({ref,token:await this.objects.prove(ref,check)});
      const asset:Asset={id,version:'1',purpose:'image',blob:source.blob,dependencies:[ref,source.raster.pixels],safety:'safe',availability:'available',qualification:'canonical-raster',measuredMediaType:'image/png',raster:{...source.raster,schemaVersion:1,manifest:ref,role:'composite',sourceAssetIds:[source.id],conversion:null}};
      validateAsset(asset);for(const proof of proofs)this.objects.proven(proof.ref,proof.token);return {asset,proofs};
    }catch(error){for(const proof of proofs)this.objects.releaseProof(proof.token);throw error;}
  }
  /** Called during explicit review, before the encoded-only acceptance interval. */
  async retainEncodedAdoption(source:Asset,candidate:Asset,original:Asset,mask:Asset,plan:RequestRasterPlan,outputMapping:RequestOutputMapping|null,slot:string,check:()=>void,documentId:string){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');const releaseCoverage=adapterResources.uncovered('raster-document-job');this.documentBusy=true;
    const proofs:{ref:BlobRef;token:string}[]=[],directory=join(this.directory,'encoded-review-'+randomUUID()),reservation=slot+':encoded-review';
    try{
      check();privateDirectory(directory);this.db.prepare('INSERT INTO deletion_work VALUES (?,?)').run(directory,documentId);
      this.objects.reserve(reservation,BigInt(plan.document.width*plan.document.height*6+3*1048576));
      if(process.memoryUsage().rss+this.externalCPU()+R16_ENCODED_ALLOCATION_BYTES>512*1024*1024)throw new StoreError('CAPACITY');this.reservedCPU=R16_ENCODED_ALLOCATION_BYTES;
      const image=(asset:Asset,encoded:Asset,encoding:'canonical-png'|'candidate-original'):EncodedRasterIdentity=>{
        if(!asset.raster||asset.raster.role==='mask'||encoding==='canonical-png'&&encoded.blob.mediaType!=='image/png')throw new AssetRejection('INCOMPATIBLE','ENCODED_REBUILD_INPUT_REQUIRED');
        return {assetId:asset.id,assetVersion:asset.version,assetHash:hashBytes(canonical(asset)),info:structuredClone(asset.raster),encoding,encoded:encoded.blob,encodedAssetId:encoded.id};
      };
      const sourceIdentity=image(source,source,'canonical-png'),candidateIdentity=image(candidate,original,'candidate-original');
      const protect=async(ref:BlobRef)=>{if(!proofs.some(p=>canonical(p.ref)===canonical(ref)))proofs.push({ref,token:await this.objects.prove(ref,check)});};
      await protect(sourceIdentity.encoded);await protect(candidateIdentity.encoded);
      const r16:EncodedR16Identity[]=[];
      for(const [index,pixels]of [plan.authoredMask,plan.effectiveMask,outputMapping?.effectiveMask??plan.effectiveMask].entries()){
        await protect(pixels);const path=join(directory,'mask-'+index+'.r16z');
        await encodeR16(this.objects.path(pixels),path,plan.document.width,plan.document.height,check);
        const encoded=encodedFileRef(path,R16_ENCODED_MEDIA_TYPE,check);proofs.push({ref:encoded,token:await this.objects.adoptFile(path,encoded,check)});
        r16.push({encoded,pixels,width:plan.document.width,height:plan.document.height,codec:R16_ENCODED_CODEC});
      }
      const encoded:EncodedAdoptionInputs={kind:'encoded-adoption-inputs-1',source:sourceIdentity,candidate:candidateIdentity,mask:{assetId:mask.id,assetVersion:mask.version,assetHash:hashBytes(canonical(mask)),info:structuredClone(mask.raster!),authored:r16[0],effective:r16[1],approved:r16[2]}};
      check();for(const proof of proofs)this.objects.proven(proof.ref,proof.token);return {encoded,proofs};
    }catch(error){for(const proof of proofs)this.objects.releaseProof(proof.token);throw error;}
    finally{try{rmSync(directory,{recursive:true,force:true});this.db.prepare('DELETE FROM deletion_work WHERE path=?').run(directory);}catch(error){for(const proof of proofs)this.objects.releaseProof(proof.token);throw error;}finally{this.objects.unreserve(reservation);this.documentBusy=false;this.reservedCPU=0;releaseCoverage();this.schedule();}}
  }
  /** The accepted job receives encoded capabilities and immutable expected hashes only. */
  async prepareEncodedPreservation(encoded:EncodedAdoptionInputs,plan:RequestRasterPlan,outputMapping:RequestOutputMapping|null,id:string,slot:string,check:()=>void,documentId:string){
    if(encoded.kind!=='encoded-adoption-inputs-1')throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');
    if(encoded.source.encoding!=='canonical-png'||encoded.source.encodedAssetId!==encoded.source.assetId||encoded.candidate.encoding!=='candidate-original'||encoded.mask.info.role!=='mask')throw new AssetRejection('INCOMPATIBLE','ENCODED_REBUILD_INPUT_REQUIRED');
    validateRequestRasterPlan(plan);
    if(canonical(encoded.source.info.pixels)!==canonical(plan.sourcePixels)||canonical(encoded.mask.authored.pixels)!==canonical(plan.authoredMask)||canonical(encoded.mask.effective.pixels)!==canonical(plan.effectiveMask)||canonical(encoded.mask.approved.pixels)!==canonical(outputMapping?.effectiveMask??plan.effectiveMask))throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');
    const refs:BlobRef[]=[],images=[encoded.source,encoded.candidate],checks=()=>{
      check();for(const frozen of [...images,encoded.mask]){const asset=this.assets.asset(frozen.assetId);if(!asset||asset.safety!=='safe'||asset.availability!=='available'||asset.qualification!=='canonical-raster'||asset.version!==frozen.assetVersion||hashBytes(canonical(asset))!==frozen.assetHash||canonical(asset.raster)!==canonical(frozen.info))throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');}
      for(const image of images)if(canonical(this.assets.asset(image.encodedAssetId)?.blob)!==canonical(image.encoded))throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');
    };
    const file=(identity:EncodedRasterIdentity):EncodedRasterFile=>{refs.push(identity.encoded,identity.info.manifest);return {identity,encodedPath:this.objects.path(identity.encoded)};};
    const source=file(encoded.source),candidate=file(encoded.candidate),r16=(identity:EncodedR16Identity)=>{if(identity.codec!==R16_ENCODED_CODEC||identity.encoded.mediaType!==R16_ENCODED_MEDIA_TYPE)throw new AssetRejection('INCOMPATIBLE','ENCODED_REBUILD_INPUT_REQUIRED');refs.push(identity.encoded);return {identity,encodedPath:this.objects.path(identity.encoded)};};
    refs.push(encoded.mask.info.manifest);
    const mask={id:encoded.mask.assetId,info:encoded.mask.info,authored:r16(encoded.mask.authored),effective:r16(encoded.mask.effective),approved:r16(encoded.mask.approved)};
    const dependencies=[encoded.source.info.manifest,encoded.candidate.info.manifest,encoded.mask.info.manifest];for(const ref of [plan.sourcePixels,plan.authoredMask,plan.effectiveMask,...(outputMapping?[outputMapping.effectiveMask]:[])])if(!dependencies.some(r=>canonical(r)===canonical(ref)))dependencies.push(ref);
    if(outputMapping)requireOutputMapping(plan,outputMapping,encoded.candidate.info.width,encoded.candidate.info.height);
    return this.prepareEncodedJob({type:'encoded-preserve',source,candidate,mask,plan,...(outputMapping?{outputMapping}:{}),dependencies},refs,id,slot,checks,documentId);
  }
  /** Freeze every remaining stack input before acceptance. The generated layer
   * is a placeholder, never a claim that preserved Q already exists. */
  async retainEncodedComposition(body:Extract<RasterBody,{type:'ComposeRaster'}>,candidateAssetId:string,slot:string,check:()=>void,documentId:string){
    validateEncodedCompositionLayers(body.width,body.height,body.layers);
    if(body.layers.filter(layer=>layer.assetId===candidateAssetId).length!==1||body.layers.some(layer=>layer.mask?.assetId===candidateAssetId))throw new AssetRejection('INCOMPATIBLE','ENCODED_REBUILD_PLACEMENT_REQUIRED');
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');const releaseCoverage=adapterResources.uncovered('raster-document-job');this.documentBusy=true;
    const proofs:{ref:BlobRef;token:string}[]=[],directory=join(this.directory,'encoded-stack-review-'+randomUUID()),reservation=slot+':encoded-stack-review';
    try{
      check();privateDirectory(directory);this.db.prepare('INSERT INTO deletion_work VALUES (?,?)').run(directory,documentId);
      const ids=[...new Set(body.layers.flatMap(layer=>[layer.assetId,...(layer.mask?[layer.mask.assetId]:[])]))].filter(id=>id!==candidateAssetId),r16Ids=new Set(body.layers.filter(layer=>layer.mask&&r16Mask(layer.mask)).map(layer=>layer.mask!.assetId));
      if(ids.length>199)throw new AssetRejection('CAPACITY','ENCODED_REBUILD_INPUT_LIMIT');
      const assets=ids.map(id=>this.asset(id,true)),images:EncodedRasterIdentity[]=[],masks:EncodedCompositionMaskIdentity[]=[];
      const byId=new Map(assets.map(asset=>[asset.id,asset]));
      for(const layer of body.layers){if(layer.assetId!==candidateAssetId&&byId.get(layer.assetId)!.raster!.role==='mask')throw new AssetRejection('INCOMPATIBLE','ENCODED_REBUILD_INPUT_REQUIRED');
        if(layer.mask){const info=byId.get(layer.mask.assetId)!.raster!,grid=maskGrid(layer.mask,body.width,body.height);if((info.role==='mask')!==r16Mask(layer.mask)||info.width!==grid.width||info.height!==grid.height)throw new AssetRejection('INCOMPATIBLE','ENCODED_REBUILD_INPUT_REQUIRED');}
      }
      const snapshots=new Map(assets.map(asset=>[asset.id,canonical(asset)]));
      const checks=()=>{check();for(const [id,snapshot]of snapshots)if(canonical(this.assets.asset(id))!==snapshot)throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');};
      const protect=async(ref:BlobRef)=>{if(!proofs.some(proof=>canonical(proof.ref)===canonical(ref)))proofs.push({ref,token:await this.objects.prove(ref,checks)});};
      const maskSources=assets.filter(asset=>r16Ids.has(asset.id)).map(asset=>{if(asset.raster!.role!=='mask')throw new AssetRejection('INCOMPATIBLE','ENCODED_REBUILD_INPUT_REQUIRED');const manifest=this.assetManifest(asset),coverage=(manifest.plan as {effective:BlobRef}).effective;if(!coverage||coverage.mediaType!=='application/x-ideogram-r16le'||coverage.byteLength!==String(asset.raster!.width*asset.raster!.height*2))throw new StoreError('CORRUPT_OBJECT');return {asset,coverage};});
      this.objects.reserve(reservation,maskSources.reduce((bytes,row)=>bytes+BigInt(row.coverage.byteLength)+1048576n,1048576n));
      if(process.memoryUsage().rss+this.externalCPU()+R16_ENCODED_ALLOCATION_BYTES>512*1024*1024)throw new StoreError('CAPACITY');this.reservedCPU=R16_ENCODED_ALLOCATION_BYTES;
      for(const asset of assets){const info=asset.raster!;await protect(info.manifest);
        if(r16Ids.has(asset.id)){const coverage=maskSources.find(row=>row.asset.id===asset.id)!.coverage;await protect(coverage);const path=join(directory,'mask-'+masks.length+'.r16z');await encodeR16(this.objects.path(coverage),path,info.width,info.height,checks);
          const encoded=encodedFileRef(path,R16_ENCODED_MEDIA_TYPE,checks);proofs.push({ref:encoded,token:await this.objects.adoptFile(path,encoded,checks)});
          masks.push({assetId:asset.id,assetVersion:asset.version,assetHash:hashBytes(canonical(asset)),info:structuredClone(info),coverage:{encoded,pixels:coverage,width:info.width,height:info.height,codec:R16_ENCODED_CODEC}});
        }else{if(info.role==='mask'||asset.blob.mediaType!=='image/png')throw new AssetRejection('INCOMPATIBLE','ENCODED_REBUILD_INPUT_REQUIRED');await protect(asset.blob);images.push({assetId:asset.id,assetVersion:asset.version,assetHash:hashBytes(canonical(asset)),info:structuredClone(info),encoding:'canonical-png',encoded:structuredClone(asset.blob),encodedAssetId:asset.id});}
      }
      const encoded:EncodedCompositionInputs={kind:'encoded-composition-inputs-1',width:body.width,height:body.height,candidateAssetId,layers:structuredClone(body.layers),images,masks};validateEncodedCompositionInputs(encoded);
      checks();for(const proof of proofs)this.objects.proven(proof.ref,proof.token);return {encoded,proofs};
    }catch(error){for(const proof of proofs)this.objects.releaseProof(proof.token);throw error;}
    finally{try{rmSync(directory,{recursive:true,force:true});this.db.prepare('DELETE FROM deletion_work WHERE path=?').run(directory);}catch(error){for(const proof of proofs)this.objects.releaseProof(proof.token);throw error;}finally{this.objects.unreserve(reservation);this.documentBusy=false;this.reservedCPU=0;releaseCoverage();this.schedule();}}
  }
  /** All old inputs are encoded review capabilities. Only the fresh Q supplied
   * by the accepting parent replaces the reviewed candidate placeholder. */
  async prepareEncodedComposition(body:Extract<RasterBody,{type:'ComposeRaster'}>,id:string,slot:string,check:()=>void,preparedInput?:Asset,documentId?:string,frozen?:EncodedCompositionInputs){
    validateEncodedCompositionLayers(body.width,body.height,body.layers);
    if(!preparedInput?.raster||preparedInput.qualification!=='canonical-raster'||preparedInput.safety!=='safe'||preparedInput.availability!=='available'||preparedInput.raster.role==='mask'||preparedInput.blob.mediaType!=='image/png')throw new AssetRejection('INCOMPATIBLE','ENCODED_REBUILD_PLACEMENT_REQUIRED');
    if(frozen){validateEncodedCompositionInputs(frozen);const layers=frozen.layers.map(layer=>layer.assetId===frozen.candidateAssetId?{...layer,assetId:preparedInput.id}:layer);
      if(body.width!==frozen.width||body.height!==frozen.height||canonical(body.layers)!==canonical(layers)||frozen.images.some(input=>input.assetId===preparedInput.id)||frozen.masks.some(input=>input.assetId===preparedInput.id))throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');
    }else if(body.layers.length!==1||body.layers[0].assetId!==preparedInput.id||body.layers[0].mask!==null)throw new AssetRejection('INCOMPATIBLE','ENCODED_REBUILD_PLACEMENT_REQUIRED');
    const identity:EncodedRasterIdentity={assetId:preparedInput.id,assetVersion:preparedInput.version,assetHash:hashBytes(canonical(preparedInput)),info:structuredClone(preparedInput.raster),encoding:'canonical-png',encoded:structuredClone(preparedInput.blob),encodedAssetId:preparedInput.id};
    return this.encodedComposition(body,id,slot,check,[identity,...(frozen?.images??[])],frozen?.masks??[],documentId,new Set([preparedInput.id]));
  }
  private async encodedComposition(body:Extract<RasterBody,{type:'ComposeRaster'}>,id:string,slot:string,check:()=>void,images:readonly EncodedRasterIdentity[],masks:readonly EncodedCompositionMaskIdentity[],documentId?:string,unregistered:ReadonlySet<string>=new Set(),comparison?:LetteringComparison){
    check();for(const identity of masks){const manifest=this.assetManifest(this.asset(identity.assetId,true));if(canonical((manifest.plan as {effective:BlobRef}).effective)!==canonical(identity.coverage.pixels))throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');}
    const refs:BlobRef[]=[],dependencies:BlobRef[]=[],add=(ref:BlobRef)=>{if(!refs.some(value=>canonical(value)===canonical(ref)))refs.push(ref);};
    const inputs:EncodedRasterFile[]=images.map(identity=>{add(identity.encoded);add(identity.info.manifest);dependencies.push(identity.info.manifest);return {identity,encodedPath:this.objects.path(identity.encoded)};});
    const maskInputs:EncodedCompositionMaskFile[]=masks.map(identity=>{add(identity.coverage.encoded);add(identity.info.manifest);dependencies.push(identity.info.manifest);return {identity,encodedPath:this.objects.path(identity.coverage.encoded)};});
    const checks=()=>{check();for(const identity of [...images,...masks]){if(unregistered.has(identity.assetId))continue;const asset=this.assets.asset(identity.assetId);
      if(!asset||asset.qualification!=='canonical-raster'||asset.safety!=='safe'||asset.availability!=='available'||asset.version!==identity.assetVersion||hashBytes(canonical(asset))!==identity.assetHash||canonical(asset.raster)!==canonical(identity.info)||'encoded'in identity&&(identity.encoding!=='canonical-png'||identity.encodedAssetId!==identity.assetId||canonical(asset.blob)!==canonical(identity.encoded)))throw new AssetRejection('STALE_REVISION','CANDIDATE_REVIEW_CHANGED');}
    };
    return this.prepareEncodedJob({type:'encoded-compose',width:body.width,height:body.height,layers:body.layers,inputs, masks:maskInputs,dependencies,...(comparison?{comparison}:{})},refs,id,slot,checks,documentId);
  }
  /** Review-only images use the returned candidate before preservation, mapped
   * into the disclosed document grid with exact native contributions. */
  async prepareLetteringComparisons(body:{width:number;height:number;candidate:Asset;candidateTransform:Affine;nativeOff:Extract<RasterBody,{type:'ComposeRaster'}>;nativeOn:Extract<RasterBody,{type:'ComposeRaster'}>},id:string,slot:string,check:()=>void,documentId:string){
    const candidate=body.candidate;if(!candidate.raster||candidate.qualification!=='canonical-raster'||candidate.safety!=='safe'||candidate.availability!=='available'||candidate.raster.role==='mask'||candidate.blob.mediaType!=='image/png')throw new AssetRejection('INCOMPATIBLE','LETTERING_COMPARISON_INPUT');
    const candidateLayer={assetId:candidate.id,transform:body.candidateTransform,opacity:1,mask:null},candidateOnly:Extract<RasterBody,{type:'ComposeRaster'}>={type:'ComposeRaster',width:body.width,height:body.height,layers:[candidateLayer]},proofs:{ref:BlobRef;token:string}[]=[],outputs:Asset[]=[];
    for(const composition of [candidateOnly,body.nativeOff,body.nativeOn]){validateEncodedCompositionLayers(composition.width,composition.height,composition.layers);if(composition.width!==body.width||composition.height!==body.height||canonical(composition.layers.filter(layer=>layer.assetId===candidate.id))!==canonical([candidateLayer]))throw new AssetRejection('INCOMPATIBLE','LETTERING_COMPARISON_MAPPING');}
    const identity:EncodedRasterIdentity={assetId:candidate.id,assetVersion:candidate.version,assetHash:hashBytes(canonical(candidate)),info:structuredClone(candidate.raster),encoding:'canonical-png',encoded:structuredClone(candidate.blob),encodedAssetId:candidate.id};
    try{for(const [index,composition]of [candidateOnly,body.nativeOff,body.nativeOn].entries()){
      const retained=await this.retainEncodedComposition(composition,candidate.id,slot,check,documentId);proofs.push(...retained.proofs);
      const value=await this.encodedComposition(composition,index===0?id:randomUUID(),slot,check,[identity,...retained.encoded.images],retained.encoded.masks,documentId,new Set(),(['candidate-alone','native-off','native-on'] as const)[index]);proofs.push(...value.proofs);outputs.push(value.asset);
    }check();for(const proof of proofs)this.objects.proven(proof.ref,proof.token);return {candidateAlone:outputs[0],nativeOff:outputs[1],nativeOn:outputs[2],proofs};}
    catch(error){for(const proof of proofs)this.objects.releaseProof(proof.token);throw error;}
  }
  private async prepareEncodedJob(job:Omit<Extract<EncodedRasterJob,{type:'encoded-preserve'}>,'directory'>|Omit<Extract<EncodedRasterJob,{type:'encoded-compose'}>,'directory'>,refs:BlobRef[],id:string,slot:string,check:()=>void,documentId?:string){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');const releaseCoverage=adapterResources.uncovered('raster-document-job');this.documentBusy=true;
    const proofs:{ref:BlobRef;token:string}[]=[],directory=join(this.directory,'encoded-accept-'+randomUUID());
    try{
      check();if(documentId&&this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(documentId))throw new StoreError('STALE_EPOCH');privateDirectory(directory);if(documentId)this.db.prepare('INSERT INTO deletion_work VALUES (?,?)').run(directory,documentId);
      // There is deliberately no proof or path lookup for old canonical pixels.
      for(const ref of refs)if(!proofs.some(p=>canonical(p.ref)===canonical(ref)))proofs.push({ref,token:await this.objects.prove(ref,check)});
      const result=await this.compute({...job,directory},slot,check,{documentId,outputAssetId:id});validateManifest(result.manifest);
      if(hashBytes(canonical(result.manifest))!==result.info.manifest.hash||canonical(result.manifest.pixels)!==canonical(result.info.pixels)||!result.encodedRebuild?.scratchRemoved)throw new StoreError('CORRUPT_OBJECT');
      for(const proof of proofs)this.objects.proven(proof.ref,proof.token);
      for(const file of result.files)if(!proofs.some(p=>canonical(p.ref)===canonical(file.ref)))proofs.push({ref:file.ref,token:await this.objects.adoptFile(join(directory,file.name),file.ref,check)});
      check();const asset:Asset={id,version:'1',purpose:'image',blob:result.png,dependencies:[result.info.manifest,result.info.pixels],safety:'safe',availability:'available',qualification:job.type==='encoded-compose'&&job.comparison?'canonical-png':'canonical-raster',measuredMediaType:'image/png',raster:result.info};validateAsset(asset);
      this.observations.add({phase:'encoded-input-rebuild',operation:job.type,slot,documentId,outputAssetId:id,output:{encoded:result.png,pixels:result.info.pixels},evidence:result.encodedRebuild,metrics:result.metrics});return {asset,proofs,metrics:result.metrics};
    }catch(error){for(const proof of proofs)this.objects.releaseProof(proof.token);throw error;}
    finally{try{rmSync(directory,{recursive:true,force:true});this.db.prepare('DELETE FROM deletion_work WHERE path=?').run(directory);}catch(error){for(const proof of proofs)this.objects.releaseProof(proof.token);throw error;}finally{this.documentBusy=false;this.reservedCPU=0;releaseCoverage();this.schedule();}}
  }
  async prepareDocument(body: (Extract<RasterBody,{type:'ComposeRaster'|'ExportRaster'}>&{requestSource?:RequestSourceCapture})|{type:'RequestMaskTransport'|'RequestSourceTransport';assetId:string;plan:RequestRasterPlan}|{type:'PreserveRequestCandidate';sourceAssetId:string;candidateAssetId:string;maskAssetId:string;plan:RequestRasterPlan;outputMapping?:RequestOutputMapping}|{type:'RetainText';source:BlobRef;pixels:BlobRef;width:number;height:number}|{type:'PrepareCandidate';assetId:string}|{type:'SolidBackground';width:number;height:number;color:readonly [number,number,number,255]}, id:string, slot:string, check:()=>void, preparedInput?:Asset,workDocumentId?:string) {
    if(this.running||this.documentBusy||this.closing)throw new StoreError('QUEUE_FULL');
    const releaseCoverage=adapterResources.uncovered('raster-document-job');this.documentBusy=true;
    const proofs:{ref:BlobRef;token:string}[]=[];
    try {
      const requestPlan='plan' in body?body.plan:undefined;if(requestPlan)validateRequestRasterPlan(requestPlan);
      const ids=body.type==='ComposeRaster'?[...new Set(body.layers.flatMap(l=>[l.assetId,...(l.mask?[l.mask.assetId]:[])]))]:body.type==='PreserveRequestCandidate'?[...new Set([body.sourceAssetId,body.candidateAssetId,body.maskAssetId])]:body.type==='ExportRaster'||body.type==='RequestMaskTransport'||body.type==='RequestSourceTransport'?[body.assetId]:[];
      const inputs:InputRaster[]=[],dependencies:BlobRef[]=[];
      for(const assetId of ids){const a=preparedInput?.id===assetId?preparedInput:this.asset(assetId,true);const info=a.raster!;
        for(const ref of [info.pixels,info.manifest])if(!proofs.some(p=>p.ref.hash===ref.hash))proofs.push({ref,token:await this.objects.prove(ref,check)});
        const maskPlan=info.role==='mask'?this.manifest(assetId).plan as {hard:BlobRef;effective:BlobRef}:undefined;let coverage=maskPlan?.effective;if(coverage)proofs.push({ref:coverage,token:await this.objects.prove(coverage,check)});
        if(body.type==='RequestMaskTransport'||body.type==='PreserveRequestCandidate'&&assetId===body.maskAssetId){
          if(!maskPlan||info.width!==body.plan.document.width||info.height!==body.plan.document.height||canonical(maskPlan.hard)!==canonical(body.plan.authoredMask)||canonical(coverage)!==canonical(body.plan.effectiveMask))throw new AssetRejection('STALE_REVISION','REQUEST_RASTER_DEPENDENCIES_CHANGED');
          if(body.type==='PreserveRequestCandidate'&&body.outputMapping)coverage=body.outputMapping.effectiveMask;
        }
        if(body.type==='RequestSourceTransport'||body.type==='PreserveRequestCandidate'&&assetId===body.sourceAssetId)if(info.role==='mask'||canonical(info.pixels)!==canonical(body.plan.sourcePixels)||info.width!==body.plan.document.width||info.height!==body.plan.document.height)throw new AssetRejection('STALE_REVISION','REQUEST_RASTER_DEPENDENCIES_CHANGED');
        if(coverage&&!proofs.some(p=>canonical(p.ref)===canonical(coverage)))proofs.push({ref:coverage,token:await this.objects.prove(coverage,check)});
        inputs.push({id:assetId,info,path:this.objects.path(info.pixels),...(coverage?{coveragePath:this.objects.path(coverage)}:{})});dependencies.push(info.manifest);
      }
      if(requestPlan)for(const ref of [requestPlan.sourcePixels,requestPlan.authoredMask,requestPlan.effectiveMask,...(body.type==='PreserveRequestCandidate'&&body.outputMapping?[body.outputMapping.effectiveMask]:[])]){if(!proofs.some(p=>canonical(p.ref)===canonical(ref)))proofs.push({ref,token:await this.objects.prove(ref,check)});if(!dependencies.some(r=>canonical(r)===canonical(ref)))dependencies.push(ref);}
      if(body.type==='PreserveRequestCandidate'&&body.outputMapping){const candidate=inputs.find(i=>i.id===body.candidateAssetId)!;requireOutputMapping(body.plan,body.outputMapping,candidate.info.width,candidate.info.height);}
      if(body.type==='ComposeRaster'&&body.requestSource){validateRequestSourceCapture(body.requestSource);const ref=body.requestSource.image.state;proofs.push({ref,token:await this.objects.prove(ref,check)});dependencies.push(ref);}
      check();const ownedDocument=workDocumentId??(slot.startsWith('history:')?String(this.db.prepare("SELECT json_extract(canonical,'$.command.documentId') AS document_id FROM history_preparations WHERE id=?").get(slot.slice(8))?.document_id??''):null);
      if(ownedDocument&&this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(ownedDocument))throw new StoreError('STALE_EPOCH');
      const exportId=slot.startsWith('history:')&&this.db.prepare("SELECT 1 FROM history_preparations WHERE id=? AND json_extract(canonical,'$.command.body.type')='ExportDocument'").get(slot.slice(8))?slot.slice(8):null;
      const directory=join(this.directory,(exportId?'export-'+exportId+'.':'')+randomUUID());privateDirectory(directory);
      if(ownedDocument)this.db.prepare('INSERT INTO deletion_work VALUES (?,?)').run(directory,ownedDocument);
      if(body.type==='RetainText')for(const ref of [body.source,body.pixels])proofs.push({ref,token:await this.objects.prove(ref,check)});
      const original=body.type==='PrepareCandidate'?this.assets.asset(body.assetId):null;
      if(body.type==='PrepareCandidate'){if(!original||original.qualification!=='pending-decoder')throw new StoreError('MALFORMED_REQUEST');proofs.push({ref:original.blob,token:await this.objects.prove(original.blob,check)});}
      const job:RasterJob=body.type==='SolidBackground'?{type:'solid-background',directory,width:body.width,height:body.height,color:body.color}:body.type==='PrepareCandidate'?{type:'decode',directory,path:this.objects.path(original!.blob),mediaType:original!.measuredMediaType,original:original!.blob,sourceAssetId:original!.id}:body.type==='RequestMaskTransport'||body.type==='RequestSourceTransport'?{type:body.type==='RequestMaskTransport'?'request-mask':'request-source',directory,input:inputs[0],plan:body.plan,dependencies}:body.type==='PreserveRequestCandidate'?{type:'preserve-request',directory,source:inputs.find(i=>i.id===body.sourceAssetId)!,candidate:inputs.find(i=>i.id===body.candidateAssetId)!,mask:inputs.find(i=>i.id===body.maskAssetId)!,plan:body.plan,...(body.outputMapping?{outputMapping:body.outputMapping}:{}),dependencies}:body.type==='RetainText'?{type:'text',directory,path:this.objects.path(body.pixels),source:body.source,width:body.width,height:body.height,dependencies:[body.source]}:body.type==='ComposeRaster'?{type:'compose',directory,width:body.width,height:body.height,layers:body.layers,inputs,dependencies,...(body.requestSource?{requestSource:body.requestSource}:{})}:{type:'export',directory,input:inputs[0],dependencies,...(body.type==='ExportRaster'&&body.options?{options:body.options}:{})};
      const result=await this.compute(job,slot,check,{documentId:ownedDocument||undefined,outputAssetId:id});validateManifest(result.manifest);
      if(hashBytes(canonical(result.manifest))!==result.info.manifest.hash)throw new StoreError('CORRUPT_OBJECT');
      for(const p of proofs)this.objects.proven(p.ref,p.token);
      for(const file of result.files)if(!proofs.some(p=>canonical(p.ref)===canonical(file.ref)))proofs.push({ref:file.ref,token:await this.objects.adoptFile(join(directory,file.name),file.ref,check)});
      const asset:Asset={id,version:'1',purpose:'image',blob:result.png,dependencies:[result.info.manifest,result.info.pixels],safety:'safe',availability:'available',qualification:body.type==='ExportRaster'?(result.png.mediaType==='image/jpeg'?'canonical-jpeg':'canonical-png'):'canonical-raster',measuredMediaType:result.png.mediaType as 'image/png'|'image/jpeg',raster:result.info};
      validateAsset(asset);return {asset,proofs,metrics:result.metrics};
    } catch(e){for(const p of proofs)this.objects.releaseProof(p.token);throw e;}
    finally{this.documentBusy=false;this.reservedCPU=0;releaseCoverage();this.schedule();}
  }
  readDiagnostics(){
    const observations=this.observations.borrow(),workerPhases=this.workerPhases.borrow();
    return this.diagnosticReads.read(8192+diagnosticPayloadBytes(observations)+diagnosticPayloadBytes(workerPhases),()=>({preparations:Number(this.db.prepare('SELECT count(*) AS n FROM raster_preparations').get()!.n),approvalAuthorities:this.approvalAuth.size,activeWorkers:this.workerOwner.snapshot.activeJobs,workerService:this.workerOwner.snapshot,reservedCPU:this.reservedCPU,observations:structuredClone(observations),workerPhases:structuredClone(workerPhases),droppedWorkerPhases:this.workerPhases.dropped,droppedObservations:this.observations.dropped}));
  }
  pressure(){return !!this.db.prepare("SELECT id FROM raster_preparations WHERE phase='waiting-for-resources' LIMIT 1").get();}
  async close(){this.closing=true;for(const flag of this.importCancellations.values())Atomics.store(new Uint32Array(flag),0,1);await this.workerOwner.close();await this.running;diagnosticReleases([{release:()=>this.cleanupPortableComparisons()},{release:()=>this.observations.dispose()},{release:()=>this.workerPhases.dispose()}])();}
}

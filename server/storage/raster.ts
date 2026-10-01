import {maskImports,maskSource} from '../../src/raster/mask.js';
import {sanitizePhaseContext,type PhaseContext} from '../../src/observability/phases.js';
import type {RasterWorkerSnapshot} from '../raster/active-compute.js';
import {validateRequestRasterPlan,requireOutputMapping,type RequestRasterPlan,type RequestOutputMapping} from '../../src/request/raster-plan.js';
import {validateRequestSourceCapture,type RequestSourceCapture} from '../../src/protocol/request-edits.js';
import {RasterWorkerOwner} from '../raster/worker-owner.js';
import { randomUUID } from 'node:crypto';
import { join, basename, dirname } from 'node:path';
import { rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Asset, AssetFact } from '../../src/protocol/assets.js';
import type { BlobRef, Receipt } from '../../src/protocol/store.js';
import type { RasterReview, RasterManifest } from '../../src/protocol/raster.js';
import type { RasterBody } from '../../src/protocol/raster.js';
import type { RasterJob, RasterResult, ResourcePlan, InputRaster } from '../raster/engine.js';
import { canonical, hashBytes, isId, parseCommand } from './canonical.js';
import { StoreError, safeError } from './errors.js';
import { AssetRejection } from './assets.js';
import type { Assets, AssetAuth } from './assets.js';
import type { Objects, Barrier } from './objects.js';
import { privateDirectory, assertComponents, assertPrivate, syncDirectory } from './files.js';
import { asset as validateAsset, rasterManifest as validateManifest, contributionStack } from '../../src/protocol/validate.js';
import { parseControlJSON } from '../control-json.js';
import { lineageRecord } from '../portable/lineage.js';

export const isRasterCommand=(type:string)=>['PrepareMask','PrepareRequestMask','PrepareRaster','ReviewRaster','ApproveRaster','ComposeRaster','ExportRaster'].includes(type);
type Commit=(bytes:Uint8Array,build:()=>AssetFact,failure?:()=>void)=>Receipt;
export class Rasters {
  private documentBusy = false;
  private directory:string;private running:Promise<void>|undefined;private closing=false;private paused=new Set<string>();private workerOwner=new RasterWorkerOwner();
  observations:Record<string,unknown>[]=[];private reservedCPU=0;
  private workerPhases:RasterWorkerSnapshot[]=[];private droppedWorkerPhases=0;
  externalCPU:()=>number=()=>0;
  get reservedBytes(){return this.reservedCPU;}
  private approvalAuth=new Map<string,{auth:AssetAuth;started:number}>();
  constructor(private db:DatabaseSync,private objects:Objects,private assets:Assets,root:string,private epoch:string,private check:()=>void,private barrier:Barrier,private commit:Commit,private register:(owner:string,ref:BlobRef,proof:string)=>void){
    this.directory=join(root,'raster-work');privateDirectory(this.directory);
    // A committed export receipt owns no mutable worker output. After restart
    // there are no surviving workers or proofs, so finish interrupted cleanup.
    const exportPrefix=join(this.directory,'export-');
    for(const row of this.db.prepare('SELECT path FROM deletion_work WHERE substr(path,1,length(?))=?').all(exportPrefix,exportPrefix)){
      const name=basename(String(row.path)),match=/^export-([A-Za-z0-9_-]{1,128})\.[0-9a-f-]{36}$/.exec(name);
      if(match&&dirname(String(row.path))===this.directory&&this.db.prepare("SELECT 1 FROM commands WHERE id=? AND json_extract(canonical,'$.command.body.type')='ExportDocument'").get(match[1]))this.cleanupDocumentExport(match[1]);
    }
    // Deletion drops ownership before its collector unlinks bytes. Retained
    // asset rows remain replay records; only rooted manifests are live graphs.
    for(const row of this.db.prepare("SELECT id FROM assets WHERE json_type(json,'$.raster')='object' AND EXISTS(SELECT 1 FROM roots WHERE hash=json_extract(assets.json,'$.raster.manifest.hash'))").iterate())try{this.manifest(String(row.id));}catch(e){if(!(e instanceof StoreError)||!['MISSING_OBJECT','CORRUPT_OBJECT'].includes(e.code))throw e;}
  }
  private transaction<T>(run:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{this.check();const result=run();this.db.exec('COMMIT');return result;}catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}}
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
    try{const request=parseCommand(Buffer.from(String(r.original))),c=request.command;if(c.commandId!==id||canonical(request)!==r.canonical||hashBytes(String(r.canonical))!==r.hash||!['PrepareMask','PrepareRequestMask','PrepareRaster','ApproveRaster','ComposeRaster','ExportRaster'].includes(c.body.type)||!isId(r.operation_id)||!['preparing','waiting-for-resources'].includes(String(r.phase)))throw new Error();
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
      const plan=manifest.plan as Record<string,unknown>;if((asset.raster.role==='mask')!==(['authored-mask-v1','authored-mask-v2','authored-request-mask-v1'].includes(String(plan.kind))))throw Error('MASK_ROLE');if(asset.raster.role==='mask'&&asset.raster.schemaVersion!==manifest.schemaVersion)throw Error('MASK_VERSION');if(asset.raster.role==='native'&&(plan.kind!=='decoded-native'||canonical(plan.conversion)!==canonical(asset.raster.conversion)||canonical(asset.raster.sourceAssetIds)!==canonical([plan.sourceAssetId])))throw new Error();
      if(asset.raster.role==='export'){
        if(!['frozen-png-export','frozen-image-export-v1'].includes(String(plan.kind)))throw Error('EXPORT_PLAN');
        const format=plan.kind==='frozen-png-export'?'png':(plan.options as {format:string}).format;
        if(asset.qualification!==(format==='jpeg'?'canonical-jpeg':'canonical-png'))throw Error('EXPORT_FORMAT');
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
    if(a.qualification!=='raster-preview'||!a.raster||a.raster.role!=='native')throw new AssetRejection('INCOMPATIBLE','RASTER_PREVIEW_REQUIRED');
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
    const previous=this.db.prepare('SELECT hash,receipt FROM commands WHERE id=?').get(c.commandId);if(previous){if(previous.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');return JSON.parse(String(previous.receipt));}
    if(this.db.prepare('SELECT id FROM history_preparations WHERE id=?').get(c.commandId))throw new StoreError('COMMAND_ID_REUSE');
    const foreign=this.assets.pending(c.commandId);if(foreign){if(foreign.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');throw new StoreError('CORRUPT_STORE');}
    const pending=this.pending(c.commandId);if(pending&&pending.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');
    if(body.type==='ApproveRaster'){
      try{this.approval(body,auth);}catch(e){if(e instanceof AssetRejection){this.approvalAuth.delete(c.commandId);return this.commit(bytes,()=>{throw e;});}throw e;}
    }
    if(pending){if(body.type==='ApproveRaster')this.approvalAuth.set(c.commandId,{auth:{...auth},started:performance.now()});this.paused.delete(c.commandId);this.schedule(true);return null;}
    if(body.type==='ReviewRaster')return this.commit(bytes,()=>{
      const a=this.asset(body.assetId);this.owner(a.id,auth.clientId);if(a.qualification!=='raster-preview'||!a.raster)throw new AssetRejection('INCOMPATIBLE','RASTER_PREVIEW_REQUIRED');
        const value={protocolVersion:1 as const,reviewId:randomUUID(),assetId:a.id,manifestHash:a.raster.manifest.hash,pixelIdentity:a.raster.pixelIdentity,targetClientId:auth.clientId,expiresAt:new Date(Math.min(auth.expires,auth.now+1800000)).toISOString(),conversion:a.raster.conversion,previewAssetId:a.id};
        const review={...value,reviewHash:hashBytes(canonical(value))};this.db.prepare('INSERT INTO raster_reviews VALUES (?,?,?,?)').run(review.reviewId,canonical(review),auth.sessionHash,this.epoch);return {type:'RasterReviewPrepared',payload:{reviewId:review.reviewId,reviewHash:review.reviewHash}};
    });
    if(!['PrepareMask','PrepareRequestMask','PrepareRaster','ApproveRaster','ComposeRaster','ExportRaster'].includes(body.type))throw new StoreError('UNSUPPORTED_COMMAND');
    if(body.type==='PrepareRaster')this.owner(body.assetId,auth.clientId);
    if(Number(this.db.prepare('SELECT (SELECT count(*) FROM raster_preparations)+(SELECT count(*) FROM asset_preparations)+(SELECT count(*) FROM history_preparations)+(SELECT count(*) FROM portable_preparations) AS n').get()!.n)>=64){this.approvalAuth.delete(c.commandId);throw new StoreError('QUEUE_FULL');}
    this.transaction(()=>{if(this.db.prepare('SELECT hash FROM asset_preparations WHERE id=?').get(c.commandId))throw new StoreError('COMMAND_ID_REUSE');this.db.prepare('INSERT INTO raster_preparations VALUES (?,?,?,?,?,?)').run(c.commandId,hash,Buffer.from(bytes).toString('utf8'),serialized,randomUUID(),'preparing');this.barrier(body.type==='ApproveRaster'?'raster-approval-preparation-before-commit':'raster-preparation-before-commit');});
    if(body.type==='ApproveRaster'){this.approvalAuth.set(c.commandId,{auth:{...auth},started:performance.now()});this.barrier('raster-approval-preparation-after-commit');}
    this.barrier('raster-preparation-after-commit');this.schedule(true);return null;
  }
  schedule(retry=false){if(this.closing||this.running)return;setImmediate(()=>{
    if(this.closing||this.running||this.documentBusy)return;const rows=this.db.prepare("SELECT id FROM raster_preparations WHERE phase='preparing' OR ? ORDER BY id LIMIT 64").all(retry?1:0);
    const row=rows.find(r=>!this.paused.has(String(r.id)));if(!row)return;const id=String(row.id),slot='raster:'+id;
    try{this.objects.acquire(slot);}catch{return;}
    this.running=this.prepare(id,slot).catch(()=>{this.paused.add(id);try{this.transaction(()=>this.db.prepare("UPDATE raster_preparations SET phase='waiting-for-resources' WHERE id=?").run(id));}catch{}}).finally(()=>{this.running=undefined;this.reservedCPU=0;this.objects.unreserve(slot);this.objects.release(slot);this.schedule();});
  });}
  private async prepare(id:string,slot:string){
    const started=performance.now(),pending=this.pending(id);if(!pending)return;const row=this.db.prepare('SELECT original FROM raster_preparations WHERE id=?').get(id)!,bytes=Buffer.from(String(row.original)),body=pending.command.body;
    const proofs:{ref:BlobRef;token:string}[]=[];
    let requestDocument:string|undefined;
    const check=()=>{this.check();if(this.closing)throw new StoreError('CLOSED');if(requestDocument&&this.db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(requestDocument))throw new AssetRejection('STALE_REVISION','DOCUMENT_DELETED');};
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
      const directory=join(this.directory,randomUUID());privateDirectory(directory);let job:RasterJob;
      if(body.type==='PrepareRaster'){
        const a=capture(this.asset(body.assetId));if(a.qualification!=='pending-decoder'||!['image','mask'].includes(a.purpose))throw new AssetRejection('INCOMPATIBLE','RASTER_ORIGINAL_REQUIRED');
        await protect(a.blob);job={type:'decode',directory,path:this.objects.path(a.blob),mediaType:a.measuredMediaType,original:a.blob,sourceAssetId:a.id};
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
        inputsUnchanged();
        const a:Asset={id:pending.operationId,version:'1',purpose:'image',blob:result.png,dependencies:[result.info.manifest,result.info.pixels,...result.files.filter(f=>!['pixels.rgba','manifest.json','output.png','output.jpeg'].includes(f.name)).map(f=>f.ref)],safety:'safe',availability:'available',qualification:body.type==='PrepareRaster'?'raster-preview':body.type==='ExportRaster'?(result.png.mediaType==='image/jpeg'?'canonical-jpeg':'canonical-png'):'canonical-raster',measuredMediaType:result.png.mediaType as 'image/png'|'image/jpeg',raster:result.info};
        validateAsset(a);const refs=new Set<string>();for(const p of proofs){if(refs.has(p.ref.hash))continue;refs.add(p.ref.hash);this.register(requestDocument?'request-mask:'+requestDocument+':'+a.id:'asset:'+a.id,p.ref,p.token);}
        this.db.prepare('DELETE FROM raster_preparations WHERE id=?').run(id);return {type:'AssetRegistered',payload:{asset:a}};
      });this.barrier('raster-after-register');
      this.observations.push({commandId:id,operationId:pending.operationId,...result.metrics,fullPreparationMs:performance.now()-started,plan:result.plan,externalEffects:0});if(this.observations.length>32)this.observations.shift();
    }catch(error){
      this.observations.push({commandId:id,phase:'failure',code:error instanceof StoreError?error.code:error instanceof AssetRejection?error.reason:'UNEXPECTED',message:error instanceof Error?error.message:'unknown'});if(this.observations.length>32)this.observations.shift();
      if(error instanceof AssetRejection)this.commit(bytes,()=>{throw error;});
      else{const e=safeError(error);if(e.code!=='CLOSED'){this.paused.add(id);this.transaction(()=>this.db.prepare("UPDATE raster_preparations SET phase='waiting-for-resources' WHERE id=?").run(id));}}
    }finally{for(const p of proofs)this.objects.releaseProof(p.token);if(this.db.prepare('SELECT id FROM commands WHERE id=?').get(id))this.approvalAuth.delete(id);}
  }
  private retainWorkerPhases(snapshot:RasterWorkerSnapshot|undefined){
    if(!snapshot||snapshot.schemaVersion!==1||snapshot.lane!=='raster-worker'||!Array.isArray(snapshot.records)||snapshot.records.length>64)return;
    if(this.workerPhases.length===16){this.workerPhases.shift();this.droppedWorkerPhases++;}this.workerPhases.push(snapshot);
  }
  private async compute(job:RasterJob,slot:string,check:()=>void,context:PhaseContext={}):Promise<RasterResult>{
    // The real worker may be idle/resident, but every job independently proves
    // whole-process headroom and obtains its own output-slot reservation.
    const preflightCPU=128*1024*1024,baselineRSS=process.memoryUsage().rss+this.externalCPU();check();
    if(baselineRSS+preflightCPU>512*1024*1024)throw new StoreError('CAPACITY');this.reservedCPU=preflightCPU;
    let planBaselineRSS=baselineRSS,peakRSS=process.memoryUsage().rss,supervisorError:unknown;
    const timer=setInterval(()=>{try{check();peakRSS=Math.max(peakRSS,process.memoryUsage().rss);if(peakRSS+this.externalCPU()>512*1024*1024)throw new StoreError('CAPACITY');this.objects.capacity(0n);}catch(error){supervisorError=error;void this.workerOwner.interrupt(slot).catch(()=>{});}},1000);
    try{
      const result=await this.workerOwner.run({...job,telemetry:sanitizePhaseContext(context)},slot,{
        check,
        admit:plan=>{
          check();const processRSS=process.memoryUsage().rss,externalCPU=this.externalCPU();planBaselineRSS=processRSS+externalCPU;const combined=planBaselineRSS+plan.cpuBytes;
          const allowed=Number.isSafeInteger(plan.cpuBytes)&&plan.cpuBytes>=0&&combined<=512*1024*1024;
          this.observations.push({phase:'resource-admission',slot,plan,processRSS,externalCPU,replacedCPU:this.reservedCPU,admissionBaselineRSS:planBaselineRSS,combinedReservedBytes:combined,admitted:allowed,worker:this.workerOwner.snapshot.identity});if(this.observations.length>32)this.observations.shift();
          if(!allowed)throw new StoreError('CAPACITY');this.objects.reserve(slot,BigInt(plan.diskBytes));this.reservedCPU=plan.cpuBytes;
        },
        telemetry:snapshot=>this.retainWorkerPhases(snapshot),
        failure:message=>{
          const remaining=message.resourceFailure?.outputRemaining,outputPeak=message.resourceFailure?.outputPeak;
          const retained=Number.isSafeInteger(remaining)&&Number.isSafeInteger(outputPeak)&&remaining!>0&&remaining!<=outputPeak!&&outputPeak!<=100065536;
          if(retained){this.observations.push({phase:'resource-retained',slot,outputPeak,outputRemaining:remaining,release:'OS unmap failed; retained allocation, not released. Library lease applies only to the loaded instance.'});if(this.observations.length>32)this.observations.shift();}
          return retained||message.code==='RASTER_RESOURCES'?new StoreError('CAPACITY'):new AssetRejection('INVALID_INPUT',message.code);
        }
      });
      if(supervisorError)throw supervisorError;
      result.metrics.supervisorPeakRSS=Math.max(peakRSS,process.memoryUsage().rss);result.metrics.admissionBaselineRSS=planBaselineRSS;result.metrics.combinedReservedBytes=planBaselineRSS+result.plan.cpuBytes;
      result.metrics.workerGeneration=this.workerOwner.snapshot.identity?.generation??0;result.metrics.workerThreadId=this.workerOwner.snapshot.identity?.threadId??0;return result;
    }catch(error){throw supervisorError??error;}finally{clearInterval(timer);}
  }
  rasterWorkerState(){this.check();return this.workerOwner.snapshot;}
  /** Owner-process maintenance only. There is no HTTP operation or dummy job. */
  async restartIdleWorker(expectedGeneration:number){
    this.check();if(!this.documentAvailable||this.reservedCPU!==0)throw new StoreError('QUEUE_FULL');this.documentBusy=true;
    try{
      const baseline=process.memoryUsage().rss+this.externalCPU(),preflight=128*1024*1024;
      if(baseline+preflight>512*1024*1024)throw new StoreError('CAPACITY');this.reservedCPU=preflight;
      return await this.workerOwner.restartIdle(expectedGeneration);
    }finally{this.reservedCPU=0;this.documentBusy=false;this.schedule();}
  }
  /** Display scratch uses the same single-worker admission, without asset registration. */
  async displayWork(job:Extract<RasterJob,{type:'decode'|'export'}>,slot:string,check:()=>void){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');this.documentBusy=true;
    try{return await this.compute(job,slot,check);}
    finally{this.documentBusy=false;this.reservedCPU=0;this.schedule();}
  }
  async stopDisplayWork(slot:string){await this.workerOwner.interrupt(slot);}
  async validateMaskPortable(plan:import('../../src/raster/mask.js').MaskPlan,inputs:InputRaster[],directory:string,slot:string,check:()=>void,request?:Extract<RasterJob,{type:'mask'}>['request']){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');this.documentBusy=true;
    try{return await this.compute({type:'mask',plan,inputs,directory,dependencies:[...inputs.map(i=>i.info.manifest),...(request?[request.source.info.pixels]:[])],...(request?{request}:{})},slot,check);}
    finally{this.documentBusy=false;this.reservedCPU=0;}
  }
  async validateRequestPreservationPortable(plan:RequestRasterPlan,source:InputRaster,candidate:InputRaster,mask:InputRaster,directory:string,slot:string,check:()=>void,outputMapping?:RequestOutputMapping){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');this.documentBusy=true;
    try{return await this.compute({type:'preserve-request',plan,source,candidate,mask,directory,dependencies:[source.info.manifest,candidate.info.manifest,mask.info.manifest,plan.sourcePixels,plan.authoredMask,plan.effectiveMask,...(outputMapping?[outputMapping.effectiveMask]:[])],...(outputMapping?{outputMapping}:{})},slot,check);}
    finally{this.documentBusy=false;this.reservedCPU=0;}
  }
  async validateCompositionPortable(width:number,height:number,layers:readonly import('../../src/protocol/raster.js').RasterLayer[],inputs:InputRaster[],directory:string,slot:string,check:()=>void,requestSource?:RequestSourceCapture,replay?:import('../raster/engine.js').RasterReplayIdentity){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');this.documentBusy=true;
    try{return await this.compute({type:'compose',width,height,layers,inputs,directory,dependencies:[...inputs.map(i=>i.info.manifest),...(requestSource?[requestSource.image.state]:[])],...(requestSource?{requestSource}:{}),...(replay?{replay}:{})},slot,check);}
    finally{this.documentBusy=false;this.reservedCPU=0;}
  }
  async validatePortable(path:string,mediaType:string,original:BlobRef,directory:string,slot:string,check:()=>void){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');this.documentBusy=true;
    try{return await this.compute({type:'decode',path,mediaType,original,sourceAssetId:'portable-validation',directory},slot,check);}
    finally{this.documentBusy=false;this.reservedCPU=0;}
  }
  async validateExportPortable(input:InputRaster,options:import('../../src/protocol/export.js').RasterExportOptions|undefined,directory:string,slot:string,check:()=>void,encoderTransport?:import('../raster/jpeg.js').JPEGTransport,replay?:import('../raster/engine.js').RasterReplayIdentity){
    if(!this.documentAvailable)throw new StoreError('QUEUE_FULL');this.documentBusy=true;
    try{return await this.compute({type:'export',input,options,directory,dependencies:[input.info.manifest],...(encoderTransport?{encoderTransport}:{}),...(replay?{replay}:{})},slot,check);}
    finally{this.documentBusy=false;this.reservedCPU=0;}
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
  async prepareDocument(body: (Extract<RasterBody,{type:'ComposeRaster'|'ExportRaster'}>&{requestSource?:RequestSourceCapture})|{type:'RequestMaskTransport'|'RequestSourceTransport';assetId:string;plan:RequestRasterPlan}|{type:'PreserveRequestCandidate';sourceAssetId:string;candidateAssetId:string;maskAssetId:string;plan:RequestRasterPlan;outputMapping?:RequestOutputMapping}|{type:'RetainText';source:BlobRef;pixels:BlobRef;width:number;height:number}|{type:'PrepareCandidate';assetId:string}, id:string, slot:string, check:()=>void, preparedInput?:Asset,workDocumentId?:string) {
    if(this.running||this.documentBusy||this.closing)throw new StoreError('QUEUE_FULL');
    this.documentBusy=true;
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
      const job:RasterJob=body.type==='PrepareCandidate'?{type:'decode',directory,path:this.objects.path(original!.blob),mediaType:original!.measuredMediaType,original:original!.blob,sourceAssetId:original!.id}:body.type==='RequestMaskTransport'||body.type==='RequestSourceTransport'?{type:body.type==='RequestMaskTransport'?'request-mask':'request-source',directory,input:inputs[0],plan:body.plan,dependencies}:body.type==='PreserveRequestCandidate'?{type:'preserve-request',directory,source:inputs.find(i=>i.id===body.sourceAssetId)!,candidate:inputs.find(i=>i.id===body.candidateAssetId)!,mask:inputs.find(i=>i.id===body.maskAssetId)!,plan:body.plan,...(body.outputMapping?{outputMapping:body.outputMapping}:{}),dependencies}:body.type==='RetainText'?{type:'text',directory,path:this.objects.path(body.pixels),source:body.source,width:body.width,height:body.height,dependencies:[body.source]}:body.type==='ComposeRaster'?{type:'compose',directory,width:body.width,height:body.height,layers:body.layers,inputs,dependencies,...(body.requestSource?{requestSource:body.requestSource}:{})}:{type:'export',directory,input:inputs[0],dependencies,...(body.type==='ExportRaster'&&body.options?{options:body.options}:{})};
      const result=await this.compute(job,slot,check,{documentId:ownedDocument||undefined,outputAssetId:id});validateManifest(result.manifest);
      if(hashBytes(canonical(result.manifest))!==result.info.manifest.hash)throw new StoreError('CORRUPT_OBJECT');
      for(const p of proofs)this.objects.proven(p.ref,p.token);
      for(const file of result.files)if(!proofs.some(p=>canonical(p.ref)===canonical(file.ref)))proofs.push({ref:file.ref,token:await this.objects.adoptFile(join(directory,file.name),file.ref,check)});
      const asset:Asset={id,version:'1',purpose:'image',blob:result.png,dependencies:[result.info.manifest,result.info.pixels],safety:'safe',availability:'available',qualification:body.type==='ExportRaster'?(result.png.mediaType==='image/jpeg'?'canonical-jpeg':'canonical-png'):'canonical-raster',measuredMediaType:result.png.mediaType as 'image/png'|'image/jpeg',raster:result.info};
      validateAsset(asset);return {asset,proofs,metrics:result.metrics};
    } catch(e){for(const p of proofs)this.objects.releaseProof(p.token);throw e;}
    finally{this.documentBusy=false;this.reservedCPU=0;this.schedule();}
  }
  diagnostics(){return {preparations:Number(this.db.prepare('SELECT count(*) AS n FROM raster_preparations').get()!.n),approvalAuthorities:this.approvalAuth.size,activeWorkers:this.workerOwner.snapshot.activeJobs,workerService:this.workerOwner.snapshot,reservedCPU:this.reservedCPU,observations:this.observations,workerPhases:this.workerPhases,droppedWorkerPhases:this.droppedWorkerPhases};}
  pressure(){return !!this.db.prepare("SELECT id FROM raster_preparations WHERE phase='waiting-for-resources' LIMIT 1").get();}
  async close(){this.closing=true;await this.workerOwner.close();await this.running;}
}

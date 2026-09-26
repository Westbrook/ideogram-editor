import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Asset, AssetFact } from '../../src/protocol/assets.js';
import type { BlobRef, Receipt } from '../../src/protocol/store.js';
import type { RasterReview, RasterManifest } from '../../src/protocol/raster.js';
import type { RasterJob, RasterResult, ResourcePlan, InputRaster } from '../raster/engine.js';
import { canonical, hashBytes, isId, parseCommand } from './canonical.js';
import { StoreError, safeError } from './errors.js';
import { AssetRejection } from './assets.js';
import type { Assets, AssetAuth } from './assets.js';
import type { Objects, Barrier } from './objects.js';
import { privateDirectory } from './files.js';
import { asset as validateAsset, rasterManifest as validateManifest } from '../../src/protocol/validate.js';
import { parseControlJSON } from '../control-json.js';

export const isRasterCommand=(type:string)=>['PrepareRaster','ReviewRaster','ApproveRaster','ComposeRaster','ExportRaster'].includes(type);
type Commit=(bytes:Uint8Array,build:()=>AssetFact,failure?:()=>void)=>Receipt;
export class Rasters {
  private directory:string;private running:Promise<void>|undefined;private closing=false;private paused=new Set<string>();private worker:Worker|undefined;
  observations:Record<string,unknown>[]=[];private reservedCPU=0;
  constructor(private db:DatabaseSync,private objects:Objects,private assets:Assets,root:string,private epoch:string,private check:()=>void,private barrier:Barrier,private commit:Commit,private register:(owner:string,ref:BlobRef,proof:string)=>void){
    this.directory=join(root,'raster-work');privateDirectory(this.directory);
    for(const row of this.db.prepare("SELECT id FROM assets WHERE json_type(json,'$.raster')='object'").iterate())try{this.manifest(String(row.id));}catch(e){if(!(e instanceof StoreError)||!['MISSING_OBJECT','CORRUPT_OBJECT'].includes(e.code))throw e;}
  }
  private transaction<T>(run:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{this.check();const result=run();this.db.exec('COMMIT');return result;}catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}}
  private asset(id:string,eligible=false){const a=this.assets.asset(id);if(!a)throw new AssetRejection('MISSING_ASSET','RASTER_INPUT_MISSING');
    if(a.availability!=='available'||['withheld','quarantined'].includes(a.safety))throw new AssetRejection('INCOMPATIBLE','RASTER_INPUT_WITHHELD');
    if(eligible&&(a.qualification!=='canonical-raster'||a.safety!=='safe'||!a.raster))throw new AssetRejection('INCOMPATIBLE','RASTER_REVIEW_REQUIRED');return a;}
  private owner(id:string,clientId:string){const row=this.db.prepare("SELECT c.canonical FROM events_v2 e JOIN commands c ON e.command_id=c.id WHERE json_extract(e.json,'$.type')='AssetRegistered' AND json_extract(e.json,'$.payload.asset.id')=?").get(id);
    if(!row||JSON.parse(String(row.canonical)).command.clientId!==clientId)throw new StoreError('OWNER_REQUIRED');}
  pending(id:string){if(!isId(id))throw new StoreError('MALFORMED_REQUEST');const r=this.db.prepare('SELECT * FROM raster_preparations WHERE id=?').get(id);if(!r)return null;
    try{const request=parseCommand(Buffer.from(String(r.original))),c=request.command;if(c.commandId!==id||canonical(request)!==r.canonical||hashBytes(String(r.canonical))!==r.hash||!['PrepareRaster','ComposeRaster','ExportRaster'].includes(c.body.type)||!isId(r.operation_id)||!['preparing','waiting-for-resources'].includes(String(r.phase)))throw new Error();
      return {command:c,hash:String(r.hash),operationId:String(r.operation_id),phase:String(r.phase) as 'preparing'|'waiting-for-resources'};
    }catch{throw new StoreError('CORRUPT_STORE');}}
  review(id:string,auth:AssetAuth):RasterReview{this.check();if(!isId(id))throw new StoreError('MALFORMED_REQUEST');const row=this.db.prepare('SELECT * FROM raster_reviews WHERE id=?').get(id);if(!row)throw new StoreError('NOT_FOUND');const r=JSON.parse(String(row.json)) as RasterReview;
    if(r.targetClientId!==auth.clientId)throw new StoreError('OWNER_REQUIRED');if(row.session_hash!==auth.sessionHash||row.epoch!==this.epoch||auth.now>=Date.parse(r.expiresAt))throw new StoreError('REVIEW_EXPIRED');return r;}
  manifest(id:string):RasterManifest{
    const asset=this.assets.asset(id);if(!asset?.raster)throw new StoreError('NOT_FOUND');
    let manifest:RasterManifest;try{const bytes=this.objects.verify(asset.raster.manifest,true)!;const value=parseControlJSON(bytes);validateManifest(value);if(canonical(value)!==Buffer.from(bytes).toString('utf8'))throw new Error();manifest=value as RasterManifest;
      if(manifest.width!==asset.raster.width||manifest.height!==asset.raster.height||manifest.pipeline!==asset.raster.pipeline||canonical(manifest.pixels)!==canonical(asset.raster.pixels)||hashBytes(canonical({pipeline:manifest.pipeline,width:manifest.width,height:manifest.height,tiles:manifest.tiles}))!==asset.raster.pixelIdentity)throw new Error();
      const plan=manifest.plan as Record<string,unknown>;if(asset.raster.role==='native'&&(plan.kind!=='decoded-native'||canonical(plan.conversion)!==canonical(asset.raster.conversion)||canonical(asset.raster.sourceAssetIds)!==canonical([plan.sourceAssetId])))throw new Error();
      for(const ref of [manifest.pixels,...manifest.dependencies]){const registered=this.db.prepare('SELECT byte_length FROM objects WHERE hash=?').get(ref.hash);if(!registered||registered.byte_length!==ref.byteLength||!this.db.prepare('SELECT hash FROM roots WHERE hash=?').get(ref.hash))throw new Error();}
    }catch(e){if(e instanceof StoreError)throw e;throw new StoreError('CORRUPT_STORE');}return manifest;
  }
  command(bytes:Uint8Array,auth:AssetAuth):Receipt|null{
    this.check();const request=parseCommand(bytes),c=request.command,body=c.body,serialized=canonical(request),hash=hashBytes(serialized);if(c.clientId!==auth.clientId)throw new StoreError('OWNER_REQUIRED');
    const previous=this.db.prepare('SELECT hash,receipt FROM commands WHERE id=?').get(c.commandId);if(previous){if(previous.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');return JSON.parse(String(previous.receipt));}
    const foreign=this.assets.pending(c.commandId);if(foreign){if(foreign.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');throw new StoreError('CORRUPT_STORE');}
    const pending=this.pending(c.commandId);if(pending){if(pending.hash!==hash)throw new StoreError('COMMAND_ID_REUSE');this.paused.delete(c.commandId);this.schedule(true);return null;}
    if(body.type==='ReviewRaster'||body.type==='ApproveRaster')return this.commit(bytes,()=>{
      const a=this.asset(body.assetId);this.owner(a.id,auth.clientId);if(a.qualification!=='raster-preview'||!a.raster)throw new AssetRejection('INCOMPATIBLE','RASTER_PREVIEW_REQUIRED');
      if(body.type==='ReviewRaster'){
        const value={protocolVersion:1 as const,reviewId:randomUUID(),assetId:a.id,manifestHash:a.raster.manifest.hash,pixelIdentity:a.raster.pixelIdentity,targetClientId:auth.clientId,expiresAt:new Date(Math.min(auth.expires,auth.now+1800000)).toISOString(),conversion:a.raster.conversion,previewAssetId:a.id};
        const review={...value,reviewHash:hashBytes(canonical(value))};this.db.prepare('INSERT INTO raster_reviews VALUES (?,?,?,?)').run(review.reviewId,canonical(review),auth.sessionHash,this.epoch);return {type:'RasterReviewPrepared',payload:{reviewId:review.reviewId,reviewHash:review.reviewHash}};
      }
      let review:RasterReview;try{review=this.review(body.reviewId,auth);}catch{throw new AssetRejection('INVALID_INPUT','RASTER_REVIEW_EXPIRED');}
      if(review.reviewHash!==body.reviewHash||review.assetId!==a.id||review.manifestHash!==a.raster.manifest.hash||review.pixelIdentity!==a.raster.pixelIdentity)throw new AssetRejection('STALE_REVISION','RASTER_REVIEW_CHANGED');
      // Existing roots are immutable and retained. This new logical version shares
      // exact preview bytes; acceptance never decodes or bakes them a second time.
      const accepted:Asset={...a,id:randomUUID(),qualification:'canonical-raster'};
      return {type:'AssetRegistered',payload:{asset:accepted}};
    });
    if(!['PrepareRaster','ComposeRaster','ExportRaster'].includes(body.type))throw new StoreError('UNSUPPORTED_COMMAND');
    if(body.type==='PrepareRaster')this.owner(body.assetId,auth.clientId);
    if(Number(this.db.prepare('SELECT (SELECT count(*) FROM raster_preparations)+(SELECT count(*) FROM asset_preparations) AS n').get()!.n)>=64)throw new StoreError('QUEUE_FULL');
    this.transaction(()=>{if(this.db.prepare('SELECT hash FROM asset_preparations WHERE id=?').get(c.commandId))throw new StoreError('COMMAND_ID_REUSE');this.db.prepare('INSERT INTO raster_preparations VALUES (?,?,?,?,?,?)').run(c.commandId,hash,Buffer.from(bytes).toString('utf8'),serialized,randomUUID(),'preparing');this.barrier('raster-preparation-before-commit');});
    this.barrier('raster-preparation-after-commit');this.schedule(true);return null;
  }
  schedule(retry=false){if(this.closing||this.running)return;setImmediate(()=>{
    if(this.closing||this.running)return;const rows=this.db.prepare("SELECT id FROM raster_preparations WHERE phase='preparing' OR ? ORDER BY id LIMIT 64").all(retry?1:0);
    const row=rows.find(r=>!this.paused.has(String(r.id)));if(!row)return;const id=String(row.id),slot='raster:'+id;
    try{this.objects.acquire(slot);}catch{return;}
    this.running=this.prepare(id,slot).catch(()=>{this.paused.add(id);try{this.transaction(()=>this.db.prepare("UPDATE raster_preparations SET phase='waiting-for-resources' WHERE id=?").run(id));}catch{}}).finally(()=>{this.running=undefined;this.reservedCPU=0;this.objects.unreserve(slot);this.objects.release(slot);this.schedule();});
  });}
  private async prepare(id:string,slot:string){
    const started=performance.now(),pending=this.pending(id);if(!pending)return;const row=this.db.prepare('SELECT original FROM raster_preparations WHERE id=?').get(id)!,bytes=Buffer.from(String(row.original)),body=pending.command.body;
    const proofs:{ref:BlobRef;token:string}[]=[];
    const check=()=>{this.check();if(this.closing)throw new StoreError('CLOSED');};
    try{
      const directory=join(this.directory,randomUUID());privateDirectory(directory);let job:RasterJob;
      const protect=async(ref:BlobRef)=>{if(proofs.some(p=>canonical(p.ref)===canonical(ref)))return;proofs.push({ref,token:await this.objects.prove(ref,check)});};
      if(body.type==='PrepareRaster'){
        const a=this.asset(body.assetId);if(a.qualification!=='pending-decoder'||!['image','mask'].includes(a.purpose))throw new AssetRejection('INCOMPATIBLE','RASTER_ORIGINAL_REQUIRED');
        await protect(a.blob);job={type:'decode',directory,path:this.objects.path(a.blob),mediaType:a.measuredMediaType,original:a.blob,sourceAssetId:a.id};
      }else{
        const ids=body.type==='ComposeRaster'?[...new Set(body.layers.flatMap(l=>[l.assetId,...(l.mask?[l.mask.assetId]:[])]))]:body.type==='ExportRaster'?[body.assetId]:[];
        const inputs:InputRaster[]=[],dependencies:BlobRef[]=[];
        for(const assetId of ids){const a=this.asset(assetId,true);const info=a.raster!;await protect(info.pixels);await protect(info.manifest);inputs.push({id:assetId,info,path:this.objects.path(info.pixels)});dependencies.push(info.manifest);}
        if(body.type==='ComposeRaster')job={type:'compose',directory,width:body.width,height:body.height,layers:body.layers,inputs,dependencies};
        else if(body.type==='ExportRaster')job={type:'export',directory,input:inputs[0],dependencies};else throw new StoreError('UNSUPPORTED_COMMAND');
      }
      //512 bounded proof records cover100 distinct image+mask pairs and outputs.
      // No decoded input surface is retained for each layer.
      const result=await this.compute(job,slot,check);this.barrier('raster-after-worker');
      validateManifest(result.manifest);
      if(hashBytes(canonical(result.manifest))!==result.info.manifest.hash||canonical(result.manifest.pixels)!==canonical(result.info.pixels))throw new StoreError('CORRUPT_OBJECT');
      for(const p of proofs)this.objects.proven(p.ref,p.token);
      for(const file of result.files){check();proofs.push({ref:file.ref,token:await this.objects.adoptFile(join(directory,file.name),file.ref,check)});}
      this.barrier('raster-before-register');
      this.commit(bytes,()=>{
        for(const p of proofs)this.objects.proven(p.ref,p.token);
        const a:Asset={id:pending.operationId,version:'1',purpose:'image',blob:result.png,dependencies:[result.info.manifest,result.info.pixels,...result.files.filter(f=>!['pixels.rgba','manifest.json','output.png'].includes(f.name)).map(f=>f.ref)],safety:'safe',availability:'available',qualification:body.type==='PrepareRaster'?'raster-preview':body.type==='ExportRaster'?'canonical-png':'canonical-raster',measuredMediaType:'image/png',raster:result.info};
        validateAsset(a);const refs=new Set<string>();for(const p of proofs){if(refs.has(p.ref.hash))continue;refs.add(p.ref.hash);this.register('asset:'+a.id,p.ref,p.token);}
        this.db.prepare('DELETE FROM raster_preparations WHERE id=?').run(id);return {type:'AssetRegistered',payload:{asset:a}};
      });this.barrier('raster-after-register');
      this.observations.push({commandId:id,operationId:pending.operationId,...result.metrics,fullPreparationMs:performance.now()-started,plan:result.plan,externalEffects:0});if(this.observations.length>32)this.observations.shift();
    }catch(error){
      this.observations.push({commandId:id,phase:'failure',code:error instanceof StoreError?error.code:error instanceof AssetRejection?error.reason:'UNEXPECTED',message:error instanceof Error?error.message:'unknown'});if(this.observations.length>32)this.observations.shift();
      if(error instanceof AssetRejection)this.commit(bytes,()=>{throw error;});
      else{const e=safeError(error);if(e.code!=='CLOSED'){this.paused.add(id);this.transaction(()=>this.db.prepare("UPDATE raster_preparations SET phase='waiting-for-resources' WHERE id=?").run(id));}}
    }finally{for(const p of proofs)this.objects.releaseProof(p.token);}
  }
  private compute(job:RasterJob,slot:string,check:()=>void):Promise<RasterResult>{
    return new Promise((resolve,reject)=>{
      // Parser, native-library load, hash buffers and worker heap are admitted
      // before worker construction. Decoded pixel surfaces need a second plan.
      const preflightCPU=128*1024*1024,baselineRSS=process.memoryUsage().rss;check();if(baselineRSS+preflightCPU>512*1024*1024)throw new StoreError('CAPACITY');this.reservedCPU=preflightCPU;
      const worker=new Worker(new URL('../raster/worker.js',import.meta.url),{workerData:job,env:{},resourceLimits:{maxOldGenerationSizeMb:48,maxYoungGenerationSizeMb:8},...(process.execArgv.some(a=>a.startsWith('--input-type'))?{execArgv:process.execArgv.filter(a=>!a.startsWith('--input-type'))}:{})});this.worker=worker;
      let result:RasterResult|undefined,error:unknown,admitted=false;let peakRSS=process.memoryUsage().rss;
      const timer=setInterval(()=>{try{check();peakRSS=Math.max(peakRSS,process.memoryUsage().rss);if(peakRSS>512*1024*1024)throw new StoreError('CAPACITY');this.objects.capacity(0n);}catch(e){error=e;void worker.terminate();}},1000);
      worker.on('message',message=>{
        if(message.type==='plan'){try{check();const plan=message.plan as ResourcePlan;const combined=baselineRSS+plan.cpuBytes;
          if(admitted||!Number.isSafeInteger(plan.cpuBytes)||plan.cpuBytes<0||combined>512*1024*1024){this.observations.push({phase:'resource-admission',plan,admissionBaselineRSS:baselineRSS,combinedReservedBytes:combined});if(this.observations.length>32)this.observations.shift();throw new StoreError('CAPACITY');}
          this.objects.reserve(slot,BigInt(plan.diskBytes));this.reservedCPU=plan.cpuBytes;admitted=true;worker.postMessage({type:'admit'});
        }catch(e){error=e;void worker.terminate();}}
        else if(message.type==='failure'){error=message.code==='RASTER_RESOURCES'?new StoreError('CAPACITY'):new AssetRejection('INVALID_INPUT',message.code);}
        else if(message.type==='result'){if(!admitted){error=new StoreError('CORRUPT_STORE');void worker.terminate();}else result=message.result;}
      });
      worker.on('error',()=>{error=new StoreError('CAPACITY');});
      worker.on('exit',()=>{clearInterval(timer);this.worker=undefined;if(error)reject(error);else if(result){result.metrics.supervisorPeakRSS=Math.max(peakRSS,process.memoryUsage().rss);result.metrics.admissionBaselineRSS=baselineRSS;result.metrics.combinedReservedBytes=baselineRSS+result.plan.cpuBytes;resolve(result);}else reject(new StoreError('STORAGE_FAILURE'));});
    });
  }
  diagnostics(){return {preparations:Number(this.db.prepare('SELECT count(*) AS n FROM raster_preparations').get()!.n),activeWorkers:this.worker?1:0,reservedCPU:this.reservedCPU,observations:this.observations};}
  pressure(){return !!this.db.prepare("SELECT id FROM raster_preparations WHERE phase='waiting-for-resources' LIMIT 1").get();}
  async close(){this.closing=true;await this.worker?.terminate();await this.running;}
}

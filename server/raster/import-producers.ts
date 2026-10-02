import {IMPORT_INVENTORY} from './import-inventory.js';
import {ACTIVE_COMPUTE_RESERVATION_BYTES} from './active-compute.js';
import type {ImportTelemetry} from './import-telemetry.js';
import type {Stats} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,constants,fstatSync,fsyncSync,lstatSync,openSync,readSync,unlinkSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import type {ResourcePlan} from './engine.js';
import type {DerivedRasterJob,NativeDerivedPreparation} from './derive-original.js';
import {CODEC_ID,CODECS} from './codec-platform.js';
import {resolveImportProfile,ACTIVE_IMPORT_PROFILES,type ImportRasterProfile} from './import-profile.js';
import {inspectJPEGOriginal,prepareOversizedJPEG,type QualifiedJPEGIdentity} from './jpeg-import/adapter.js';
import {prepareOversizedWebP} from './webp-import/adapter.js';
import {validateWebPIdentity,type QualifiedWebPIdentity} from './webp-import/tile-plan.js';
import {inspectContainer} from './container.js';
import {readWebPMetadata,webpExifOrientation} from './webp-metadata.js';
import {normalizeImportColorFile} from './import-color.js';
import {transformImportFile} from './import-file-transform.js';
import {encodePNG} from './png.js';
import {canonical} from '../../src/protocol/json.js';

// New artifacts are installed only with matching source, producer, platform and
// resource/CP1 qualification seals. Neither legacy decoder is an implicit fallback.
export const ISSUED_JPEG_IMPORT_SEALS:readonly QualifiedJPEGIdentity[]=Object.freeze(IMPORT_INVENTORY.jpeg as readonly QualifiedJPEGIdentity[]);
export const ISSUED_WEBP_IMPORT_SEALS:readonly QualifiedWebPIdentity[]=Object.freeze(IMPORT_INVENTORY.webp as readonly QualifiedWebPIdentity[]);
const MiB=1048576,hash=(b:Uint8Array)=>'sha256:'+createHash('sha256').update(b).digest('hex');
const same=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino;
/** Remove only the output whose exclusive creation was observed. A changed
 * inode is a cleanup failure; the durable parent directory claim must remain. */
export function removeOwnedImportOutput(path:string,expected:Pick<Stats,'dev'|'ino'>):void {
 try{if(!same(expected as Stats,lstatSync(path)))throw Error('RASTER_INPUT_CHANGED');unlinkSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
/** Seals retain a portable vendor path; native loading receives an absolute
 * path under the installed package root, independent of process.cwd(). */
export function resolveImportArtifactPath(path:string,packageRoot?:string):string{
 if(!/^vendor\/raster\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(path)||path.split('/').some(part=>part==='.'||part==='..'))throw Error('RASTER_CODEC_UNQUALIFIED');
 const root=packageRoot??dirname(dirname(dirname(dirname(createRequire(import.meta.url).resolve('sharp')))));
 if(!isAbsolute(root))throw Error('RASTER_CODEC_UNQUALIFIED');return resolve(root,path);
}
function sealFor(profile:ImportRasterProfile){
 const seals=profile.producer.transport==='jpeg-scanline-file-v1'?ISSUED_JPEG_IMPORT_SEALS:ISSUED_WEBP_IMPORT_SEALS;
 const seal=seals.find(s=>s.platform===profile.platform&&s.arch===profile.arch&&s.kind===profile.producer.transport&&s.artifact.hash===profile.producer.artifactHash&&s.sourceHash===profile.producer.sourceHash&&s.abiVersion===profile.producer.abiVersion&&s.qualificationHash===profile.qualificationHash);
 return seal?{...seal,artifact:{...seal.artifact,path:resolveImportArtifactPath(seal.artifact.path)}}:undefined;
}
export async function importProducerAvailable(profile:ImportRasterProfile):Promise<boolean>{
 if(!ACTIVE_IMPORT_PROFILES.includes(profile)||profile.baseCodec!==CODEC_ID||profile.platform!==process.platform||profile.arch!==process.arch)return false;
 if(profile.producer.transport==='png-scanline-file-cp1-v1')return true;
 const seal=sealFor(profile);if(!seal)return false;
 try{
  if(seal.kind==='webp-advanced-file-v1')validateWebPIdentity(seal);
  const fd=openSync(seal.artifact.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const s=fstatSync(fd,{bigint:true});if(!s.isFile()||s.nlink!==1n||s.size!==BigInt(seal.artifact.bytes))return false;const b=Buffer.alloc(65536),h=createHash('sha256');let n;while((n=readSync(fd,b)))h.update(b.subarray(0,n));const t=fstatSync(fd,{bigint:true});return s.dev===t.dev&&s.ino===t.ino&&s.size===t.size&&s.mtimeNs===t.mtimeNs&&s.ctimeNs===t.ctimeNs&&'sha256:'+h.digest('hex')===seal.artifact.hash;}finally{closeSync(fd);}
 }catch{return false;}
}
/** Called only by runRaster after the writer's actual 128MiB preflight lease.
 * Bounded metadata inspection uses that preflight. Exactly one admit below
 * replaces it before native mappings, source/target scratch or color work. */
export async function prepareNativeDerived(job:DerivedRasterJob,admit:(plan:ResourcePlan)=>Promise<void>,check:()=>void,telemetry?:ImportTelemetry):Promise<NativeDerivedPreparation>{
 const profile=resolveImportProfile(job.pipeline,job.plan,{platform:process.platform,arch:process.arch});
 if(!profile||!await importProducerAvailable(profile)||profile.producer.transport==='png-scanline-file-cp1-v1')throw Error('RASTER_CODEC_UNQUALIFIED');
 const seal=sealFor(profile)!;check();
 const directory=resolve(job.directory),sourcePath=join(directory,'.original-'+randomUUID()+'.rgba'),raw=join(directory,'pixels.rgba'),png=join(directory,'output.png');
 const cancellation=job.cancellation;if(!(cancellation instanceof SharedArrayBuffer)||cancellation.byteLength!==4)throw Error('RASTER_RESOURCES');
 const owned=new Map<string,Stats>();let decodePhase:ReturnType<ImportTelemetry['start']>|undefined;let source:{path:string;bytes:number;dispose():Promise<void>}|undefined,output:number|undefined,complete=false,plan:ResourcePlan|undefined,icc:Uint8Array|undefined;
 const remove=(path:string)=>{const s=owned.get(path);if(s)removeOwnedImportOutput(path,s);};
 const admission=async(reservation:{cpuBytes:number;scratchBytes:number})=>{
  if(plan)throw Error('RASTER_DUPLICATE_ADMISSION');const rawBytes=job.plan.operation.width*job.plan.operation.height*4;
  const allocations={activeKernelTelemetry:ACTIVE_COMPUTE_RESERVATION_BYTES,workerAndBackend:96*MiB,metadata:16*MiB,decoder:reservation.cpuBytes,pinnedColor:32*MiB,sourcePages:131072,resampleRow:job.plan.operation.width*4,encoderAndIO:4*MiB};
  plan={width:job.plan.operation.width,height:job.plan.operation.height,rawBytes,cpuBytes:Object.values(allocations).reduce((a,b)=>a+b,0),diskBytes:reservation.scratchBytes+3*rawBytes+16*MiB,allocations};
  if(!Number.isSafeInteger(plan.diskBytes)||!Number.isSafeInteger(plan.cpuBytes))throw Error('RASTER_RESOURCES');await admit(plan);check();decodePhase=telemetry?.start('decode',{sourceWidth:job.plan.encoded.width,sourceHeight:job.plan.encoded.height});
  // The writer owns the cumulative lease until worker drain; adapter disposal
  // releases its subordinate lifetime without releasing the containing lease.
  return {release(){}};
 };
 const metadataMatches=(value:{encoded:{width:number;height:number};orientation:number;profile:string;profileHash:string|null})=>{if(canonical(value)!==canonical({encoded:job.plan.encoded,orientation:job.plan.orientation,profile:job.plan.profile,profileHash:job.plan.profileHash}))throw Error('RASTER_INSPECTION_CHANGED');};
 try{
  if(seal.kind==='jpeg-scanline-file-v1'){
   const original=inspectJPEGOriginal(job.path,check,{profiles:CODECS.profiles,exifOrientation:webpExifOrientation});metadataMatches({encoded:{width:original.image.width,height:original.image.height},...original.metadata});
   source=await prepareOversizedJPEG({original,output:sourcePath,seal,admit:admission,check,cancellation});
   if(job.plan.profile==='p3'){
    const segments=original.image.icc;if(!segments)throw Error('RASTER_METADATA');const length=segments.reduce((n,s)=>n+s.length,0);if(length>4*MiB)throw Error('RASTER_METADATA');icc=Buffer.alloc(length);
    const fd=openSync(job.path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const before=fstatSync(fd,{bigint:true});if(before.dev!==original.stamp.dev||before.ino!==original.stamp.ino||before.size!==original.stamp.size||before.mtimeNs!==original.stamp.mtimeNs||before.ctimeNs!==original.stamp.ctimeNs)throw Error('RASTER_INPUT_CHANGED');let at=0;for(const s of segments){check();let read=0;while(read<s.length){const n=readSync(fd,icc,at+read,s.length-read,s.offset+read);if(!n)throw Error('RASTER_INPUT_CHANGED');read+=n;}at+=s.length;}const after=fstatSync(fd,{bigint:true});if(before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||before.size!==after.size||hash(icc)!==job.plan.profileHash)throw Error('RASTER_INPUT_CHANGED');}finally{closeSync(fd);}
   }
  }else{
   const inspected=await inspectContainer(job.path,'image/webp',check,true);if(!inspected.webpMetadata)throw Error('RASTER_METADATA');const metadata=readWebPMetadata(job.path,inspected.webpMetadata,check,true);icc=metadata.icc??undefined;const profileHash=icc?hash(icc):null;
   metadataMatches({encoded:{width:inspected.width,height:inspected.height},orientation:metadata.orientation,profile:profileHash===CODECS.profiles.p3.hash?'p3':profileHash===CODECS.profiles.srgb.hash?'srgb':profileHash===null?'untagged-srgb':'unknown',profileHash});
   // The storage writer durably owns this entire exclusive job directory before
   // dispatch. These child claims inherit that recorded subtree; they do not
   // create a second untracked scratch root or release the parent ownership.
   const child=(path:string)=>{if(dirname(path)!==directory||resolve(path)!==path||!basename(path)||path===raw||path===png)throw Error('RASTER_OUTPUT_PATH');};
   source=await prepareOversizedWebP({original:{path:job.path,descriptor:inspected.webpMetadata,effectiveAlpha:metadata.hasAlpha,inspectionHash:job.plan.inspectionHash},output:sourcePath,seal,admit:admission,check,cancellation,journal:{record(path){child(path);},remove(path){child(path);}},quarantine(){Atomics.store(new Uint32Array(cancellation),0,1);}});
  }
  if(!source||!plan)throw Error('RASTER_RESOURCES');check();
  if(job.plan.profile==='p3'){if(!icc||hash(icc)!==job.plan.profileHash)throw Error('RASTER_PROFILE');const fd=openSync(source.path,constants.O_RDWR|constants.O_NOFOLLOW);try{await normalizeImportColorFile(fd,source.bytes,icc,check);}finally{closeSync(fd);}}
  decodePhase?.end();const resamplePhase=telemetry?.start('resample',{width:job.plan.operation.width,height:job.plan.operation.height,sourceWidth:job.plan.encoded.width,sourceHeight:job.plan.encoded.height});
  output=openSync(raw,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);owned.set(raw,fstatSync(output));
  await transformImportFile(source.path,output,job.plan.encoded.width,job.plan.encoded.height,job.plan.orientation,job.plan.operation,check,telemetry?.active);closeSync(output);output=undefined;resamplePhase?.end();
  const encodePhase=telemetry?.start('encode',{width:job.plan.operation.width,height:job.plan.operation.height});await encodePNG(raw,png,job.plan.operation.width,job.plan.operation.height,check,fd=>owned.set(png,fstatSync(fd)));check();encodePhase?.end();await source.dispose();source=undefined;complete=true;
  return {raw,png,width:job.plan.operation.width,height:job.plan.operation.height,plan,inspection:{encoded:job.plan.encoded,orientation:job.plan.orientation,profile:job.plan.profile,profileHash:job.plan.profileHash},derivation:{kind:'decoded-derived-v1',operation:job.plan.operation,kernel:job.plan.kernel,decodeTransport:job.plan.decodeTransport}};
 }finally{
  const errors:unknown[]=[];if(output!==undefined)try{closeSync(output);}catch(e){errors.push(e);}if(source)try{await source.dispose();}catch(e){errors.push(e);}
  if(!complete||errors.length)for(const path of [raw,png])try{remove(path);}catch(e){errors.push(e);}
  try{const fd=openSync(directory,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}catch(e){errors.push(e);}
  if(errors.length)throw new AggregateError(errors,'Raster import cleanup failed');
 }
}

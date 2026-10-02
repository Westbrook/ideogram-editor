import {closeSync,constants,fstatSync,lstatSync,openSync,readSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inspectContainer} from './container.js';
import {readWebPMetadata,sameWebPSource,webpExifOrientation} from './webp-metadata.js';
import {inspectJPEGOriginal} from './jpeg-import/adapter.js';
import {CODECS,CODEC_ID} from './codec-platform.js';
import {ISSUED_IMPORT_PROFILES,importProfileIdentity,type ImportRasterProfile} from './import-profile.js';
import type {RasterImportInspection} from '../../src/protocol/raster-import.js';
import type {ResourcePlan} from './engine.js';

export type OriginalInspectionMetadata=Pick<RasterImportInspection,'encoded'|'orientation'|'profile'|'profileHash'|'capabilities'>;
const hash=(bytes:Uint8Array)=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
/** Run in the raster worker under one real R31 admission, with original proof held. */
export async function inspectRasterOriginal(path:string,mediaType:string,admit:(plan:ResourcePlan)=>Promise<void>,check:()=>void,producerAvailable:(profile:ImportRasterProfile)=>Promise<boolean>):Promise<OriginalInspectionMetadata>{
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),before=fstatSync(fd,{bigint:true});
 try{
  if(!before.isFile()||before.nlink!==1n||before.size>BigInt(Number.MAX_SAFE_INTEGER))throw Error('RASTER_INPUT_CHANGED');
  const plan={width:0,height:0,rawBytes:0,cpuBytes:128*1048576,diskBytes:0,allocations:{workerAndBackend:96*1048576,metadata:32*1048576}};await admit(plan);
  const stable=()=>{check();if(!sameWebPSource(before,fstatSync(fd,{bigint:true}))||!sameWebPSource(before,lstatSync(path,{bigint:true})))throw Error('RASTER_INPUT_CHANGED');};
  let width:number,height:number,orientation=1,profile:OriginalInspectionMetadata['profile']='untagged-srgb',profileHash:string|null=null;
  if(mediaType==='image/jpeg'){
   const original=inspectJPEGOriginal(path,stable,{profiles:CODECS.profiles,exifOrientation:webpExifOrientation});({width,height}=original.image);({orientation,profile,profileHash}=original.metadata);
  }else{
   const inspected=await inspectContainer(path,mediaType,stable,true);({width,height}=inspected);
   if(mediaType==='image/webp'){
    if(!inspected.webpMetadata)throw Error('RASTER_METADATA');const metadata=readWebPMetadata(path,inspected.webpMetadata,stable,true);orientation=metadata.orientation;profileHash=metadata.icc?hash(metadata.icc):null;
   }else if(mediaType==='image/png'){
    profileHash=inspected.pngMetadata!.iccHash;
    // Full bounded chunk/CRC inspection above validates offsets and aggregate
    // metadata. Read only the EXIF payload needed for the public orientation.
    const read=(at:number,n:number)=>{stable();if(n>4*1048576||at<0||at+n>Number(before.size))throw Error('RASTER_METADATA');const b=Buffer.alloc(n);let done=0;while(done<n){const count=readSync(fd,b,done,n-done,at+done);if(!count)throw Error('RASTER_INPUT_CHANGED');done+=count;}return b;};
    for(let at=8;at<Number(before.size);){const h=read(at,8),n=h.readUInt32BE();if(h.toString('latin1',4)==='eXIf'){const bytes=read(at+8,n);if(hash(bytes)!==inspected.pngMetadata!.exifHash)throw Error('RASTER_INPUT_CHANGED');orientation=webpExifOrientation(bytes);}at+=n+12;}
   }else throw Error('RASTER_FORMAT');
   if(profileHash===CODECS.profiles.srgb.hash)profile='srgb';else if(profileHash===CODECS.profiles.p3.hash)profile='p3';else if(profileHash!==null)throw Error('RASTER_PROFILE');
  }
  stable();let transport:string|null=null;
  for(const candidate of ISSUED_IMPORT_PROFILES){
   const {codec,pipeline,...definition}=candidate,identity=importProfileIdentity(definition);
   if(candidate.baseCodec!==CODEC_ID||candidate.platform!==process.platform||candidate.arch!==process.arch||candidate.producer.mediaType!==mediaType||codec!==identity.codec||pipeline!==identity.pipeline)continue;
   if(await producerAvailable(candidate)){transport=candidate.producer.transport;break;}
  }
  stable();return {encoded:{width,height},orientation,profile,profileHash,capabilities:{resize:transport,crop:transport,unavailableReason:transport?null:'BOUNDED_DECODER_UNQUALIFIED'}};
 }finally{closeSync(fd);}
}

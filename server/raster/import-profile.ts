import {IMPORT_INVENTORY} from './import-inventory.js';
import {CODEC_ID} from './codec-platform.js';
import {canonical} from '../../src/protocol/json.js';
import {PIXEL_PIPELINE} from '../../src/raster/core.js';
import {createHash} from 'node:crypto';

export type ImportProducer={
 transport:'png-scanline-file-cp1-v1'|'jpeg-scanline-file-v1'|'webp-advanced-file-v1';
 mediaType:'image/png'|'image/jpeg'|'image/webp';sourceHash:string;artifactHash:string|null;abiVersion:number|null;
};
export type ImportRasterProfile={baseCodec:string;platform:string;arch:string;producer:ImportProducer;kernel:'triangle-area-source-axis-row-norm-v1';color:'fixed-srgb-p3-orientation-v1';qualificationHash:string;codec:string;pipeline:string};
const digest=(value:unknown)=>'sha256:'+createHash('sha256').update(canonical(value)).digest('hex');
const hash=(value:unknown)=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);

/** Deterministic producer identity; invoking this does not qualify a producer. */
export function importProfileIdentity(value:Omit<ImportRasterProfile,'codec'|'pipeline'>){
 const codec=digest(value);return {codec,pipeline:PIXEL_PIPELINE+'/'+codec};
}
/** This inventory stays empty until separately reviewed source/native seals exist. */
export const ISSUED_IMPORT_PROFILES:readonly ImportRasterProfile[]=Object.freeze(IMPORT_INVENTORY.profiles as readonly ImportRasterProfile[]);
export const ACTIVE_IMPORT_PROFILES:readonly ImportRasterProfile[]=Object.freeze(ISSUED_IMPORT_PROFILES.filter(profile=>(IMPORT_INVENTORY.activeProfiles as readonly string[]).includes(profile.pipeline)));
export function matchImportProfile(profile:ImportRasterProfile,pipeline:unknown,plan:Record<string,any>,execution?:{platform:string;arch:string}):boolean{
 const {codec,pipeline:expected,...definition}=profile,p=profile.producer,identity=importProfileIdentity(definition);
 if(!hash(profile.baseCodec)||!hash(profile.qualificationHash)||!hash(p.sourceHash)||identity.codec!==codec||identity.pipeline!==expected||pipeline!==expected)return false;
 if(execution&&(execution.platform!==profile.platform||execution.arch!==profile.arch))return false;
 if(profile.kernel!=='triangle-area-source-axis-row-norm-v1'||profile.color!=='fixed-srgb-p3-orientation-v1'||plan.kind!=='decoded-derived-v1'||plan.codec!==codec||plan.kernel!==profile.kernel||plan.decodeTransport!==p.transport||plan.original?.mediaType!==p.mediaType)return false;
 const expectedType={'png-scanline-file-cp1-v1':'image/png','jpeg-scanline-file-v1':'image/jpeg','webp-advanced-file-v1':'image/webp'}[p.transport];if(expectedType!==p.mediaType)return false;
 if(p.transport==='png-scanline-file-cp1-v1')return p.artifactHash===null&&p.abiVersion===null&&plan.decoderBuild===undefined&&plan.decoderABI===undefined&&plan.decoderSource===p.sourceHash;
 return hash(p.artifactHash)&&typeof p.abiVersion==='number'&&Number.isSafeInteger(p.abiVersion)&&p.abiVersion>0&&plan.decoderBuild===p.artifactHash&&plan.decoderABI===p.abiVersion&&plan.decoderSource===p.sourceHash;
}
export function resolveImportProfile(pipeline:unknown,value:unknown,execution?:{platform:string;arch:string}):ImportRasterProfile|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 return (execution?ACTIVE_IMPORT_PROFILES:ISSUED_IMPORT_PROFILES).find(profile=>(!execution||profile.baseCodec===CODEC_ID)&&matchImportProfile(profile,pipeline,value as Record<string,any>,execution));
}

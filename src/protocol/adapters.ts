import type { BlobRef, Seq } from './store.js';
import { canonical } from './json.js';
import { retainedAdapterProfile } from '../adapters/profile.js';

export type RegisterAdapterBody = {
  type: 'RegisterAdapterVersion'; adapterId: string | null; previousVersionId: string | null;
  weightsAssetId: string; configAssetId: string | null; provenanceAssetId: string | null;
  name: string; declaredFamily: string; declaredFormat: string; provenanceText: string;
};
export type AdapterBody = RegisterAdapterBody | { type: 'PreviewAdapterDeletion'; versionId: string } | { type: 'DeleteAdapterVersion'; versionId: string; planId: string; token: string };
export type AdapterDeletionRecord = { kind: 'preview' | 'deleted'; versionId: string; planId: string; token: string };
export type AdapterDeletionDependency = { kind:'draft'|'review'|'job'|'document'|'history'|'checkpoint'|'provenance'|'unavailable';id:string;detail:string };
export type AdapterDeletionPlan = { kind:'adapter-deletion-plan-1';id:string;versionId:string;adapterId:string;version:string;weights:BlobRef;owner:string;sessionId:string;dependencies:AdapterDeletionDependency[];dependencyCount:number;dependenciesTruncated:boolean;dependencyHash:string;canDelete:boolean;actualFreedBytes:'0';bytesRetained:true;token:string };
export type AdapterQualification = 'unverified' | 'structurally-valid' | 'incompatible' | 'runtime-verified';
export type AdapterVersion = {
  schemaVersion: 1; id: string; adapterId: string; version: Seq; name: string;
  weights: BlobRef; config: BlobRef | null;
  origin: { kind: 'import'; provenance: BlobRef; original: BlobRef | null };
  sources: { weightsAssetId: string; configAssetId: string | null; provenanceAssetId: string | null };
  declaredFamily: string; declaredFormat: string; qualification: AdapterQualification;
  validation: {
    report: BlobRef; inspector: 'safetensors-inspection-1'; reason: string;
    profileId: string | null; locallyEligible: boolean; runtimeVerified: false;
    structure: { headerBytes: number; dataBytes: number; tensorCount: number; dtypes: string[]; tensorSignature: string } | null;
  };
};
export type AdapterLibraryEntry = {
  versionId: string; adapterId: string; version: Seq; name: string; declaredFamily: string; declaredFormat: string;
  qualification: AdapterQualification; available: boolean; weights: BlobRef; config: BlobRef | null;
  origin: 'import'; profileId: string | null; locallyEligible: boolean; runtimeVerified: false; reason: string;
};
export type AdapterLibraryFilters = { family?: string; format?: string; origin?: string; status?: string };
export type AdapterLibraryPage = { protocolVersion: 1; items: AdapterLibraryEntry[]; nextAfter: string | null };
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const seq=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v);
function require(value:unknown):asserts value{if(!value)throw new Error('ADAPTER_RECORD_INVALID');}
function fields(value:any,names:string[]){require(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(n=>Object.hasOwn(value,n)));}
function text(value:unknown,limit:number,empty=false){require(typeof value==='string'&&value.length<=limit&&(empty||value.trim().length>0)&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value));}
function ref(value:any){fields(value,['hash','byteLength','mediaType']);require(hash(value.hash)&&typeof value.byteLength==='string'&&/^(0|[1-9][0-9]*)$/.test(value.byteLength)&&typeof value.mediaType==='string'&&/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value.mediaType)&&value.mediaType.length<=128);}
export function adapterRegistration(value:unknown):asserts value is AdapterBody{
  const v=value as any;
  if(v?.type==='PreviewAdapterDeletion'){fields(v,['type','versionId']);require(validId(v.versionId));return;}
  if(v?.type==='DeleteAdapterVersion'){fields(v,['type','versionId','planId','token']);require(validId(v.versionId)&&validId(v.planId)&&hash(v.token));return;}
  fields(v,['type','adapterId','previousVersionId','weightsAssetId','configAssetId','provenanceAssetId','name','declaredFamily','declaredFormat','provenanceText']);
  require(v.type==='RegisterAdapterVersion'&&validId(v.weightsAssetId)&&[v.adapterId,v.previousVersionId,v.configAssetId,v.provenanceAssetId].every(x=>x===null||validId(x))&&(v.adapterId===null)===(v.previousVersionId===null));
  text(v.name,120);text(v.declaredFamily,120);text(v.declaredFormat,120);text(v.provenanceText,4096,true);
}
export function adapterVersion(value:unknown):asserts value is AdapterVersion{
  const v=value as any;fields(v,['schemaVersion','id','adapterId','version','name','weights','config','origin','sources','declaredFamily','declaredFormat','qualification','validation']);
  require(v.schemaVersion===1&&validId(v.id)&&validId(v.adapterId)&&seq(v.version)&&['unverified','structurally-valid','incompatible'].includes(v.qualification));
  text(v.name,120);text(v.declaredFamily,120);text(v.declaredFormat,120);ref(v.weights);require(v.weights.mediaType==='application/octet-stream');if(v.config!==null)ref(v.config);
  fields(v.origin,['kind','provenance','original']);require(v.origin.kind==='import');ref(v.origin.provenance);require(v.origin.provenance.mediaType==='application/json');if(v.origin.original!==null)ref(v.origin.original);
  fields(v.sources,['weightsAssetId','configAssetId','provenanceAssetId']);require(validId(v.sources.weightsAssetId)&&[v.sources.configAssetId,v.sources.provenanceAssetId].every(x=>x===null||validId(x))&&(v.config===null)===(v.sources.configAssetId===null)&&(v.origin.original===null)===(v.sources.provenanceAssetId===null));
  const r=v.validation;fields(r,['report','inspector','reason','profileId','locallyEligible','runtimeVerified','structure']);ref(r.report);require(r.report.mediaType==='application/json'&&r.inspector==='safetensors-inspection-1'&&(r.profileId===null||typeof r.profileId==='string'&&r.profileId.length<=128)&&typeof r.locallyEligible==='boolean'&&r.runtimeVerified===false);text(r.reason,512);
  if(r.structure!==null){fields(r.structure,['headerBytes','dataBytes','tensorCount','dtypes','tensorSignature']);require(Number.isSafeInteger(r.structure.headerBytes)&&r.structure.headerBytes>0&&r.structure.headerBytes<=1048576&&Number.isSafeInteger(r.structure.dataBytes)&&r.structure.dataBytes>=0&&Number.isSafeInteger(r.structure.tensorCount)&&r.structure.tensorCount>0&&Array.isArray(r.structure.dtypes)&&r.structure.dtypes.length<=64&&r.structure.dtypes.every((d:unknown)=>typeof d==='string'&&d.length<=16)&&hash(r.structure.tensorSignature));}
  require(v.qualification!=='structurally-valid'||r.structure!==null);
  if(r.locallyEligible){require(v.qualification==='structurally-valid'&&r.structure!==null);const trusted=retainedAdapterProfile({weightsHash:v.weights.hash,configHash:v.config?.hash??null,declaredFamily:v.declaredFamily,declaredFormat:v.declaredFormat,tensorSignature:r.structure.tensorSignature,origin:v.origin.kind});require(trusted.locallyEligible&&trusted.profileId===r.profileId);}else require(r.profileId===null);
}
export function adapterDependencies(v:AdapterVersion):BlobRef[]{
  return [...new Map([v.config,v.origin.provenance,v.origin.original,v.validation.report].filter((r):r is BlobRef=>r!==null).map(r=>[canonical(r),r])).values()];
}

export function adapterDeletionRecord(value:unknown):asserts value is AdapterDeletionRecord { const v=value as any;fields(v,['kind','versionId','planId','token']);require(['preview','deleted'].includes(v.kind)&&validId(v.versionId)&&validId(v.planId)&&hash(v.token)); }

import type {BlobRef} from './store.js';

/** Logical content lengths are not allocated disk usage. Categories may overlap. */
export const STORAGE_CATEGORIES = ['all','originals','canonical','masks','candidates','adapters','datasets','history','staging','previews'] as const;
export type StorageCategory = typeof STORAGE_CATEGORIES[number];
export const STORAGE_PAGE_SIZE = 20;
export const STORAGE_RESPONSE_BYTES = 60 * 1024;
export const STORAGE_CLEAR_SCOPE = 'registered-unpinned-display-derivatives' as const;
export type StorageObservation = {protocolVersion:1;epoch:string;highWater:string};
export type StorageCategoryUsage = {id:StorageCategory;label:string;assetCount:number;objectCount:number;knownBytes:string;complete:boolean;unknownCount:number|null;assetRows:boolean};
export type StoragePreviewCache = {entries:number;knownBytes:string;pinnedEntries:number;activeBuilds:number;clearableEntries:number;clearableBytes:string;scope:'registered-display-derivatives'};
export type StorageSummary = StorageObservation & {
  categories:StorageCategoryUsage[];
  registeredObjects:{count:number;knownBytes:string;complete:boolean};
  filesystem:{availableBytes:string;totalBytes:string};
  appPhysicalBytes:null;
  accounting:'logical-content-bytes; categories may overlap';
  previewCache:StoragePreviewCache;
};
export type StorageAsset = {id:string;version:string;purpose:string;qualification:string;recordedAvailability:'available'|'missing'|'corrupt';availability:'present-unverified'|'missing'|'unavailable';availabilityScope:'primary-object-only';blob:BlobRef;knownBytes:string};
export type StorageAssetPage = StorageObservation & {category:StorageCategory;items:StorageAsset[];nextCursor:string|null;complete:boolean};
export type StorageDependency =
  | {kind:'object';id:string;label:string;relation:'expected-object';ref:BlobRef;availability:'present-unverified'|'missing'|'unavailable'}
  | {kind:'root';id:string;label:string;relation:'asset-reference'|'content-root'|'shared-dependency-root'};
export type StorageDependencyPage = StorageObservation & {asset:StorageAsset;items:StorageDependency[];nextCursor:string|null;complete:boolean};
export type StorageCacheClearResult = StorageObservation & {
  scope:typeof STORAGE_CLEAR_SCOPE;outcome:'complete'|'partial';removedEntries:number;freedLogicalBytes:string;
  pinnedEntries:number;activeBuilds:number;retainedEntries:number;examinedEntries:number;unexaminedEntries:number;
  failures:{key:string;reason:'identity'|'unexpected-members'|'remove-failed'}[];
  untrackedScope:'retained-not-enumerated';
};

const fail=():never=>{throw Error('STORAGE_RESPONSE');};
function record(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))return fail();
  const row=value as Record<string,unknown>,actual=Object.keys(row);
  if(actual.length!==keys.length||actual.some(key=>!keys.includes(key)))return fail();return row;
}
function string(value:unknown,max=128):asserts value is string{if(typeof value!=='string'||value.length>max)return fail();}
function id(value:unknown){string(value);if(!/^[A-Za-z0-9_-]{1,128}$/.test(value))fail();}
function seq(value:unknown){string(value,40);if(!/^(0|[1-9][0-9]*)$/.test(value))fail();}
function count(value:unknown){if(!Number.isSafeInteger(value)||Number(value)<0)fail();}
function bool(value:unknown){if(typeof value!=='boolean')fail();}
function choice(value:unknown,choices:readonly unknown[]){if(!choices.includes(value))fail();}
function array(value:unknown,max:number):unknown[]{if(!Array.isArray(value)||value.length>max)return fail();return value;}
function blob(value:unknown){const r=record(value,['hash','byteLength','mediaType']);string(r.hash,71);if(!/^sha256:[a-f0-9]{64}$/.test(r.hash))fail();seq(r.byteLength);string(r.mediaType,128);if(!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(r.mediaType))fail();}
function observation(r:Record<string,unknown>){if(r.protocolVersion!==1)fail();seq(r.epoch);seq(r.highWater);}
export function validateStorageAsset(value:unknown):StorageAsset{const r=record(value,['id','version','purpose','qualification','recordedAvailability','availability','availabilityScope','blob','knownBytes']);id(r.id);seq(r.version);choice(r.purpose,['image','mask','adapter','font','caption','bundle','text']);string(r.qualification,64);choice(r.recordedAvailability,['available','missing','corrupt']);choice(r.availability,['present-unverified','missing','unavailable']);if(r.availabilityScope!=='primary-object-only')fail();blob(r.blob);seq(r.knownBytes);return value as StorageAsset;}
function cache(value:unknown){const r=record(value,['entries','knownBytes','pinnedEntries','activeBuilds','clearableEntries','clearableBytes','scope']);for(const key of ['entries','pinnedEntries','activeBuilds','clearableEntries'])count(r[key]);seq(r.knownBytes);seq(r.clearableBytes);if(r.scope!=='registered-display-derivatives'||Number(r.pinnedEntries)+Number(r.clearableEntries)>Number(r.entries))fail();}
function page(r:Record<string,unknown>){if(r.nextCursor!==null)id(r.nextCursor);bool(r.complete);}
function bounded<T>(value:unknown):T{if(new TextEncoder().encode(JSON.stringify(value)).byteLength>=STORAGE_RESPONSE_BYTES)fail();return value as T;}

/** Validators throw on any unsupported shape and return the original typed value. */
export function validateStorageSummary(value:unknown):StorageSummary{
  const r=record(value,['protocolVersion','epoch','highWater','categories','registeredObjects','filesystem','appPhysicalBytes','accounting','previewCache']);observation(r);
  const rows=array(r.categories,STORAGE_CATEGORIES.length);if(rows.length!==STORAGE_CATEGORIES.length)fail();
  rows.forEach((value,index)=>{const c=record(value,['id','label','assetCount','objectCount','knownBytes','complete','unknownCount','assetRows']);if(c.id!==STORAGE_CATEGORIES[index])fail();string(c.label,80);count(c.assetCount);count(c.objectCount);seq(c.knownBytes);bool(c.complete);bool(c.assetRows);if(c.unknownCount!==null)count(c.unknownCount);});
  const objects=record(r.registeredObjects,['count','knownBytes','complete']);count(objects.count);seq(objects.knownBytes);bool(objects.complete);
  const fs=record(r.filesystem,['availableBytes','totalBytes']);seq(fs.availableBytes);seq(fs.totalBytes);
  if(r.appPhysicalBytes!==null||r.accounting!=='logical-content-bytes; categories may overlap')fail();cache(r.previewCache);return bounded(value);
}
export function validateStorageAssetPage(value:unknown):StorageAssetPage{
  const r=record(value,['protocolVersion','epoch','highWater','category','items','nextCursor','complete']);observation(r);choice(r.category,STORAGE_CATEGORIES);array(r.items,STORAGE_PAGE_SIZE).forEach(validateStorageAsset);page(r);return bounded(value);
}
export function validateStorageDependencyPage(value:unknown):StorageDependencyPage{
  const r=record(value,['protocolVersion','epoch','highWater','asset','items','nextCursor','complete']);observation(r);validateStorageAsset(r.asset);page(r);
  array(r.items,STORAGE_PAGE_SIZE).forEach(value=>{
    if(!value||typeof value!=='object')fail();const kind=(value as {kind?:unknown}).kind;
    if(kind==='object'){const d=record(value,['kind','id','label','relation','ref','availability']);string(d.id,71);if(!/^sha256:[a-f0-9]{64}$/.test(d.id as string))fail();string(d.label,160);if(d.relation!=='expected-object')fail();blob(d.ref);choice(d.availability,['present-unverified','missing','unavailable']);}
    else {const d=record(value,['kind','id','label','relation']);if(d.kind!=='root')fail();string(d.id,512);string(d.label,160);choice(d.relation,['asset-reference','content-root','shared-dependency-root']);}
  });return bounded(value);
}
export function validateStorageCacheClearResult(value:unknown):StorageCacheClearResult{
  const r=record(value,['protocolVersion','epoch','highWater','scope','outcome','removedEntries','freedLogicalBytes','pinnedEntries','activeBuilds','retainedEntries','examinedEntries','unexaminedEntries','failures','untrackedScope']);observation(r);
  if(r.scope!==STORAGE_CLEAR_SCOPE||r.untrackedScope!=='retained-not-enumerated')fail();choice(r.outcome,['complete','partial']);for(const key of ['removedEntries','pinnedEntries','activeBuilds','retainedEntries','examinedEntries','unexaminedEntries'])count(r[key]);seq(r.freedLogicalBytes);
  array(r.failures,128).forEach(value=>{const f=record(value,['key','reason']);string(f.key,64);if(!/^[a-f0-9]{64}$/.test(f.key as string))fail();choice(f.reason,['identity','unexpected-members','remove-failed']);});
  if(((r.failures as unknown[]).length||Number(r.unexaminedEntries))&&r.outcome!=='partial')fail();if(Number(r.examinedEntries)>128||Number(r.removedEntries)>Number(r.examinedEntries))fail();return bounded(value);
}
export function validateStorageCacheClearRequest(value:unknown):{protocolVersion:1;scope:typeof STORAGE_CLEAR_SCOPE}{const r=record(value,['protocolVersion','scope']);if(r.protocolVersion!==1||r.scope!==STORAGE_CLEAR_SCOPE)fail();return value as {protocolVersion:1;scope:typeof STORAGE_CLEAR_SCOPE};}

import {randomUUID} from 'node:crypto';
import {lstatSync,statfsSync} from 'node:fs';
import {dirname} from 'node:path';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import type {Asset} from '../../src/protocol/assets.js';
import type {BlobRef} from '../../src/protocol/store.js';
import {STORAGE_CATEGORIES,STORAGE_CLEAR_SCOPE,STORAGE_PAGE_SIZE,validateStorageAsset,validateStorageSummary,validateStorageAssetPage,validateStorageDependencyPage,validateStorageCacheClearResult,type StorageCategory,type StorageCategoryUsage,type StorageAsset,type StorageDependency,type StorageAssetPage,type StorageDependencyPage} from '../../src/protocol/storage.js';
import type {AssetAuth} from './assets.js';
import type {Objects} from './objects.js';
import type {Displays} from './display.js';
import {canonical,hashBytes,isId,isSeq,validateBlob} from './canonical.js';
import {assertComponents,assertPrivate} from './files.js';
import type {StorageLibraryMemory,StorageLibraryScope} from './library-memory.js';
import {StoreError} from './errors.js';

const ROWS=4096,METADATA=262144,PAGE_SCAN=128,PAGE_BYTES=4*1024*1024;
const definitions:Record<StorageCategory,{label:string;where?:string}>= {
  all:{label:'All registered assets',where:'1=1'},
  originals:{label:'Encoded originals',where:"json_extract(a.json,'$.purpose')='image' AND json_extract(a.json,'$.measuredMediaType') IN ('image/png','image/jpeg','image/webp')"},
  canonical:{label:'Canonical raster objects',where:"json_extract(a.json,'$.qualification') IN ('canonical-raster','canonical-png','canonical-jpeg')"},
  masks:{label:'Mask objects',where:"json_extract(a.json,'$.purpose')='mask'"},
  candidates:{label:'Retained candidate objects',where:"EXISTS (SELECT 1 FROM candidate_asset_evidence c WHERE c.asset_id=a.id)"},
  adapters:{label:'Adapter objects',where:"json_extract(a.json,'$.purpose')='adapter'"},
  datasets:{label:'Dataset storage (not independently indexed)'},
  history:{label:'History/checkpoint JSON metadata'},staging:{label:'Staged uploads (committed bytes)'},previews:{label:'Registered display derivatives'},
};
type Cursor={scope:string;client:string;session:string;epoch:string;high:string;generation:string;expires:number;after:string;phase:number;complete:boolean;assetHash?:string};
type Scan={bytes:number;nodes:number;complete:boolean};
const seq=(value:unknown):string=>{if(!isSeq(value)||value.length>40)throw new StoreError('CORRUPT_STORE');return value;};

/** Bounded observations of registered metadata, not a garbage collector or a
 * filesystem allocation census. No query deletes retained objects or roots. */
export class StorageLibrary {
  private cursors=new Map<string,Cursor>();
  constructor(private db:DatabaseSync,private objects:Objects,private displays:Displays,private root:string,private epoch:string,private check:()=>void,private memory:StorageLibraryMemory){}
  authorize(auth:AssetAuth):void{
    this.check();
    if(!auth||!isId(auth.clientId)||!/^[a-f0-9]{64}$/.test(auth.sessionHash)||!Number.isSafeInteger(auth.now)||!Number.isSafeInteger(auth.expires))throw new StoreError('OWNER_REQUIRED');
    const now=Math.max(Date.now(),auth.now),binding=this.db.prepare('SELECT client_id,expires FROM client_bindings WHERE cookie_hash=?').get(auth.sessionHash);
    if(!binding||binding.client_id!==auth.clientId||now>=auth.expires||now>=Number(binding.expires))throw new StoreError('OWNER_REQUIRED');
  }
  private observation(){return {protocolVersion:1 as const,epoch:this.epoch,highWater:seq(this.db.prepare("SELECT value FROM meta WHERE key='highWater'").get()!.value)};}
  private total(query:string,args:SQLInputValue[]=[]){
    let count=0,bytes=0n,complete=true;
    for(const row of this.db.prepare(query).iterate(...args)){if(count===ROWS){complete=false;break;}bytes+=BigInt(seq(row.bytes));count++;}
    return {count,knownBytes:String(bytes),complete};
  }
  summary(auth:AssetAuth,scope:StorageLibraryScope){const loan=this.memory.enter(scope,'summary');try{return this.summaryValue(auth);}finally{loan.release();}}
  private summaryValue(auth:AssetAuth){
    this.authorize(auth);const categories:StorageCategoryUsage[]=[],previewCache=this.displays.storageInventory();
    for(const id of STORAGE_CATEGORIES){
      const definition=definitions[id];let assetCount=0,objectCount=0,knownBytes='0',complete=false,unknownCount:number|null=null;
      if(definition.where){
        for(const _ of this.db.prepare(`SELECT a.id FROM assets a WHERE ${definition.where} ORDER BY a.id LIMIT ${ROWS+1}`).iterate()){if(assetCount===ROWS)break;assetCount++;}
        const total=this.total(`SELECT o.byte_length AS bytes FROM objects o WHERE EXISTS (SELECT 1 FROM assets a WHERE ${definition.where} AND (EXISTS (SELECT 1 FROM asset_dependencies d WHERE d.asset_id=a.id AND d.hash=o.hash) OR json_extract(a.json,'$.retainedMetadata.hash')=o.hash)) ${id==='candidates'?"OR EXISTS (SELECT 1 FROM roots r WHERE r.hash=o.hash AND r.owner GLOB 'candidate:*')":''} ORDER BY o.hash LIMIT ${ROWS+1}`);
        objectCount=total.count;knownBytes=total.knownBytes;complete=total.complete&&assetCount<ROWS;unknownCount=complete?0:null;
      }else if(id==='history'){
        const total=this.total(`SELECT CAST(length(CAST(json AS BLOB)) AS TEXT) AS bytes FROM (SELECT id,json FROM history UNION ALL SELECT id,json FROM checkpoints) ORDER BY id LIMIT ${ROWS+1}`);
        objectCount=total.count;knownBytes=total.knownBytes;complete=false;unknownCount=null; // Row bytes exclude referenced state, snapshots and journal metadata.
      }else if(id==='staging'){
        const total=this.total(`SELECT json_extract(json,'$.committedOffset') AS bytes FROM staged_assets WHERE json_extract(json,'$.state')!='finalized' ORDER BY id LIMIT ${ROWS+1}`);
        objectCount=total.count;knownBytes=total.knownBytes;complete=total.complete;unknownCount=complete?0:null;
      }else if(id==='previews'){objectCount=previewCache.entries;knownBytes=previewCache.knownBytes;complete=true;unknownCount=0;}
      categories.push({id,label:definition.label,assetCount,objectCount,knownBytes,complete,unknownCount,assetRows:!!definition.where});
    }
    const registeredObjects=this.total(`SELECT byte_length AS bytes FROM objects ORDER BY hash LIMIT ${ROWS+1}`),fs=statfsSync(this.root,{bigint:true});this.check();
    return validateStorageSummary({...this.observation(),categories,registeredObjects,filesystem:{availableBytes:String(fs.bavail*fs.bsize),totalBytes:String(fs.blocks*fs.bsize)},appPhysicalBytes:null,accounting:'logical-content-bytes; categories may overlap',previewCache});
  }
  private cursor(scope:string,cursor:string|null,auth:AssetAuth,assetHash?:string):Cursor{
    this.authorize(auth);const now=Date.now(),high=this.observation().highWater,generation=String(this.db.prepare('SELECT total_changes() AS n').get()!.n);
    for(const [id,c] of this.cursors)if(now>=c.expires)this.cursors.delete(id);
    if(cursor!==null){if(!isId(cursor))throw new StoreError('MALFORMED_REQUEST');const c=this.cursors.get(cursor);if(!c||c.scope!==scope||c.client!==auth.clientId||c.session!==auth.sessionHash||c.epoch!==this.epoch||c.high!==high||c.generation!==generation||c.assetHash!==assetHash)throw new StoreError('OFFSET_MISMATCH');this.cursors.delete(cursor);return {...c};}
    return {scope,client:auth.clientId,session:auth.sessionHash,epoch:this.epoch,high,generation,expires:Math.min(auth.expires,now+1800000),after:'',phase:0,complete:true,...(assetHash?{assetHash}:{})};
  }
  private next(c:Cursor):string{if(this.cursors.size>=128)throw new StoreError('CAPACITY');const id=randomUUID();this.cursors.set(id,{...c});return id;}
  private asset(id:string):Asset{
    if(!isId(id))throw new StoreError('MALFORMED_REQUEST');
    const row=this.db.prepare(`SELECT CASE WHEN length(CAST(json AS BLOB))<=${METADATA} THEN json ELSE NULL END AS json FROM assets WHERE id=?`).get(id);
    if(!row)throw new StoreError('NOT_FOUND');if(row.json===null)throw new StoreError('CAPACITY');return JSON.parse(String(row.json)) as Asset;
  }
  private minimal(asset:Asset):StorageAsset{return validateStorageAsset({id:asset.id,version:asset.version,purpose:asset.purpose,qualification:asset.qualification,recordedAvailability:asset.availability,availability:this.availability(asset.blob),availabilityScope:'primary-object-only',blob:asset.blob,knownBytes:asset.blob.byteLength});}
  assets(category:StorageCategory,cursor:string|null,auth:AssetAuth,scope:StorageLibraryScope):StorageAssetPage{const loan=this.memory.enter(scope,'assets');try{return this.assetsValue(category,cursor,auth);}finally{loan.release();}}
  private assetsValue(category:StorageCategory,cursor:string|null,auth:AssetAuth):StorageAssetPage{
    if(!STORAGE_CATEGORIES.includes(category))throw new StoreError('MALFORMED_REQUEST');const c=this.cursor('assets:'+category,cursor,auth),items:StorageAsset[]=[];let more=false;
    const where=definitions[category].where;
    if(where)for(const row of this.db.prepare(`SELECT a.id FROM assets a WHERE a.id>? AND ${where} ORDER BY a.id LIMIT ${STORAGE_PAGE_SIZE+1}`).iterate(c.after)){
      if(items.length===STORAGE_PAGE_SIZE){more=true;break;}const item=this.minimal(this.asset(String(row.id)));items.push(item);c.after=item.id;
    }
    this.check();return validateStorageAssetPage({...this.observation(),category,items,nextCursor:more?this.next(c):null,complete:true});
  }
  private availability(ref:BlobRef):'present-unverified'|'missing'|'unavailable'{
    const path=this.objects.path(ref);
    try{assertComponents(dirname(path));assertPrivate(dirname(path),true);assertPrivate(path,false);return String(lstatSync(path,{bigint:true}).size)===ref.byteLength?'present-unverified':'unavailable';}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 'missing';return 'unavailable';}
  }
  private refs(asset:Asset):BlobRef[]{
    // The admitted asset JSON bounds this array; do not expand raster payloads.
    const refs=[asset.blob,...asset.dependencies,...(asset.retainedMetadata?[asset.retainedMetadata]:[])];for(const ref of refs)validateBlob(ref);return refs;
  }
  private inspect(value:unknown,assetId:string,hashes:Set<string>,scan:Scan,visited:Set<string>,depth=0):'asset-reference'|'content-root'|null{
    if(depth>16||++scan.nodes>4096){scan.complete=false;return null;}if(!value||typeof value!=='object')return null;
    let relation:'asset-reference'|'content-root'|null=null;
    if(!Array.isArray(value)){
      const v=value as Record<string,unknown>;
      for(const key of ['assetId','compositeAssetId','encodedAssetId','preparedAssetId','sourceAssetId','adapterVersionId'])if(v[key]===assetId)return 'asset-reference';
      if(Array.isArray(v.sourceAssetIds)&&v.sourceAssetIds.includes(assetId))return 'asset-reference';
      if(Array.isArray(v.adapters)&&v.adapters.some(a=>a&&typeof a==='object'&&(a as {version?:unknown}).version===assetId))return 'asset-reference';
      if(typeof v.hash==='string'&&hashes.has(v.hash))relation='content-root';
      if(v.mediaType==='application/json'&&typeof v.hash==='string'&&!visited.has(v.hash)){
        try{validateBlob(v);visited.add(v.hash);const size=BigInt(v.byteLength);if(size>BigInt(METADATA)||scan.bytes+Number(size)>PAGE_BYTES){scan.complete=false;return relation;}scan.bytes+=Number(size);const bytes=this.objects.verify(v,true)!;const found=this.inspect(JSON.parse(Buffer.from(bytes).toString('utf8')),assetId,hashes,scan,visited,depth+1);if(found==='asset-reference')return found;relation??=found;}
        catch{scan.complete=false;}
      }
    }
    for(const child of Array.isArray(value)?value:Object.values(value)){const found=this.inspect(child,assetId,hashes,scan,visited,depth+1);if(found==='asset-reference')return found;relation??=found;if(scan.nodes>4096)break;}
    return relation;
  }
  dependencies(id:string,cursor:string|null,auth:AssetAuth,scope:StorageLibraryScope):StorageDependencyPage{const loan=this.memory.enter(scope,'dependencies');try{return this.dependenciesValue(id,cursor,auth);}finally{loan.release();}}
  private dependenciesValue(id:string,cursor:string|null,auth:AssetAuth):StorageDependencyPage{
    this.authorize(auth);const asset=this.asset(id),c=this.cursor('dependencies:'+id,cursor,auth,hashBytes(canonical(asset))),items:StorageDependency[]=[],refs=this.refs(asset),hashes=new Set(refs.map(r=>r.hash));
    const scan:Scan={bytes:0,nodes:0,complete:true};let scanned=0,more=false;
    // Phases retain no result arrays in cursor state. All IDs/offsets belong to
    // this authenticated, epoch/high-water-bound observation.
    if(c.phase===0){let index=c.after?Number(c.after):0;while(index<refs.length&&items.length<STORAGE_PAGE_SIZE){const ref=refs[index++]!;items.push({kind:'object',id:ref.hash,label:ref===asset.blob?'Primary asset object':'Expected dependency object',relation:'expected-object',ref,availability:this.availability(ref)});}c.after=String(index);if(index<refs.length)more=true;else{c.phase=1;c.after='';}}
    const tables=['documents','history','checkpoints','queue_jobs','assets'];
    while(!more&&c.phase>=1&&c.phase<=tables.length&&items.length<STORAGE_PAGE_SIZE&&scanned<PAGE_SCAN){
      const table=tables[c.phase-1]!;let exhausted=true;
      for(const row of this.db.prepare(`SELECT id,CASE WHEN length(CAST(json AS BLOB))<=${METADATA} THEN json ELSE NULL END AS json FROM ${table} WHERE id>? ORDER BY id LIMIT ${PAGE_SCAN+1}`).iterate(c.after)){
        if(items.length===STORAGE_PAGE_SIZE||scanned===PAGE_SCAN){exhausted=false;break;}c.after=String(row.id);scanned++;if(table==='assets'&&row.id===id)continue;
        if(row.json===null){c.complete=false;continue;}const text=String(row.json);scan.bytes+=Buffer.byteLength(text);if(scan.bytes>PAGE_BYTES){c.complete=false;continue;}
        scan.nodes=0;const relation=this.inspect(JSON.parse(text),id,hashes,scan,new Set());if(!scan.complete)c.complete=false;
        if(relation)items.push({kind:'root',id:table+':'+String(row.id),label:table+': '+String(row.id),relation:relation==='content-root'?'shared-dependency-root':relation});
      }
      if(exhausted){c.phase++;c.after='';}else more=true;
    }
    if(!more&&c.phase===tables.length+1&&items.length<STORAGE_PAGE_SIZE){
      for(const row of this.db.prepare(`WITH retained AS (SELECT owner,hash FROM roots UNION ALL SELECT 'snapshot:'||snapshot_id||':'||owner AS owner,hash FROM snapshot_roots UNION ALL SELECT 'portable:'||operation_id AS owner,hash FROM portable_pins UNION ALL SELECT 'migration-backup' AS owner,hash FROM deletion_backup_pins) SELECT r.owner,r.hash FROM retained r WHERE (r.hash IN (SELECT hash FROM asset_dependencies WHERE asset_id=?) OR r.hash=?) AND (r.owner||char(1)||r.hash)>? ORDER BY r.owner,r.hash LIMIT ${STORAGE_PAGE_SIZE+1}`).iterate(id,asset.retainedMetadata?.hash??asset.blob.hash,c.after)){
        if(items.length===STORAGE_PAGE_SIZE){more=true;break;}const owner=String(row.owner);c.after=owner+'\x01'+String(row.hash);items.push({kind:'root',id:hashBytes(c.after),label:owner.slice(0,160),relation:row.hash===asset.blob.hash?'content-root':'shared-dependency-root'});
      }
      if(!more)c.phase++;
    }
    if(c.phase<=tables.length+1)more=true;
    this.check();return validateStorageDependencyPage({...this.observation(),asset:this.minimal(asset),items,nextCursor:more?this.next(c):null,complete:c.complete});
  }
  clear(auth:AssetAuth,scope:StorageLibraryScope){const loan=this.memory.enter(scope,'clear');try{this.authorize(auth);return validateStorageCacheClearResult({...this.observation(),scope:STORAGE_CLEAR_SCOPE,...this.displays.clearRegistered(),untrackedScope:'retained-not-enumerated'});}finally{loan.release();}}
  invalidate(){this.cursors.clear();}
  close(){this.invalidate();}
}

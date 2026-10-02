import {installedSchema16Maintenance,copySchema16Maintenance,schema16MaintenanceFiles,type Schema16MaintenancePacket} from './schema16-maintenance.js';
import { supportsProjectionSchema, projectionEntity } from '../../src/protocol/projection-schema.js';
import {validateCompositionTextReview} from '../../src/composition/text-export.js';
import {textSplitPlan} from '../../src/protocol/text.js';
import {validateReturnedTextSplitOrigin} from '../../src/text/returned-description.js';
import {assertCompositionTextSchema19Ready,assertCompositionTextSchema19Receipt} from './composition-text-schema.js';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, statfsSync, openSync, readSync, writeSync, writeFileSync, constants, fstatSync, readdirSync, mkdtempSync, realpathSync, rmSync, ftruncateSync } from 'node:fs';
import { join, isAbsolute, dirname, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashBytes, isId, parseCommand } from './canonical.js';
import { privateFile, privateDirectory, syncDirectory, assertPrivate, assertComponents, inspectTree, sameFile } from './files.js';
import { StoreError } from './errors.js';
import type { Barrier } from './objects.js';
import {freezeRollbackAuthorities,selectRollbackExecutable} from './platform-authority.js';

const tables = ['meta', 'objects', 'commands', 'events', 'documents', 'history', 'checkpoints', 'roots'];

export type RequestFamilySealedFile={path:string;hash:string;byteLength:string};
export type Schema17ExecutablePacket={
  kind:'schema17-executable-packet-1';storageVersion:17;packetId:string;
  sourceArchive:RequestFamilySealedFile;sourceManifest:RequestFamilySealedFile;
  compiler:{name:'typescript';version:string;identity:string};
  toolchain:{node:'26.10.0';npm:'12.1.0';identity:string};
  dependencies:{lockfileHash:string;vendorManifestHash:string;identity:string};
  native:{profileHash:string;artifactManifestHash:string};
  platform:{os:string;arch:string;identity:string};
  compiledClosures:readonly {name:string;archive:RequestFamilySealedFile;manifest:RequestFamilySealedFile}[];
  verifiedFreshRestore:{receipt:RequestFamilySealedFile;sourceArchiveHash:string;compiledClosureHash:string;result:'verified'};
  gitCommit?:string;
};
// Root must supply a separately produced, freshly restored schema17 rollback
// packet at promotion. Neither a planning commit nor a source hash proves a
// runnable executable. Existing <=16 migrations already produce their verified
// schema16 rollback packet, which schema18 inherits without relabelling it.
export type Schema17ExecutablePin={kind:'schema17-executable-pin-1';packetId:string;identityHash:string;platform:Schema17ExecutablePacket['platform']};
export const REQUEST_FAMILY_SCHEMA17_EXECUTABLE: Schema17ExecutablePin | null = {"kind":"schema17-executable-pin-1","packetId":"schema17-1199b5949a52ab59755a8135","identityHash":"sha256:ed393175043c735213d1945a13c641881d262778f502d4ac1604662861fb0f00","platform":{"os":"darwin","arch":"arm64","identity":"sha256:348d9deb7f48dfe75031343116e784da3266f6b5fe69ef1f02a3db6c2b11b534"}};
// The singular literal above remains the genuine Darwin17 authority. Other
// platforms require separately reviewed packets; absence never means fallback.
export const REQUEST_FAMILY_SCHEMA17_AUTHORITIES=freezeRollbackAuthorities([
  {os:'darwin',arch:'arm64',pin:REQUEST_FAMILY_SCHEMA17_EXECUTABLE},
]);
export function requestFamilyExecutablePin():Schema17ExecutablePin{
  return selectRollbackExecutable('schema17-executable-pin-1',REQUEST_FAMILY_SCHEMA17_AUTHORITIES,process.platform,process.arch);
}
const requestFamilyDigest=(value:unknown):value is string=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);
function requestFamilyFileProof(file:RequestFamilySealedFile):void {
  if(!isAbsolute(file.path)||!requestFamilyDigest(file.hash)||!/^(0|[1-9][0-9]*)$/.test(file.byteLength)||BigInt(file.byteLength)>BigInt(Number.MAX_SAFE_INTEGER))throw new StoreError('CORRUPT_STORE');
  assertComponents(dirname(file.path));const before=assertPrivate(file.path,false),input=openSync(file.path,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256'),block=Buffer.alloc(1048576);let total=0n;
  try{if(!sameFile(before,fstatSync(input)))throw new StoreError('ROOT_UNSAFE');for(;;){const count=readSync(input,block);if(!count)break;total+=BigInt(count);hash.update(block.subarray(0,count));}}
  finally{closeSync(input);}
  const after=assertPrivate(file.path,false);
  if(!sameFile(before,after)||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||total!==BigInt(file.byteLength)||'sha256:'+hash.digest('hex')!==file.hash)throw new StoreError('CORRUPT_OBJECT');
}
function requestFamilyPacketFiles(packet:Schema17ExecutablePacket):RequestFamilySealedFile[]{return [packet.sourceArchive,packet.sourceManifest,...packet.compiledClosures.flatMap(value=>[value.archive,value.manifest]),packet.verifiedFreshRestore.receipt];}
function requestFamilyPacket(packet:Schema17ExecutablePacket|null):Schema17ExecutablePacket {
  if(packet===null)throw new StoreError('UNSUPPORTED_STORAGE',{kind:'fields',issues:[{path:'storage.schemaVersion',code:'REQUEST_FAMILY_ROLLBACK_EXECUTABLE_REQUIRED'}]});
  if(packet.kind!=='schema17-executable-packet-1'||packet.storageVersion!==17||!isId(packet.packetId)||packet.compiler.name!=='typescript'||!packet.compiler.version||packet.toolchain.node!=='26.10.0'||packet.toolchain.npm!=='12.1.0'||!packet.platform.os||!packet.platform.arch||packet.gitCommit!==undefined&&!/^[a-f0-9]{40}$/.test(packet.gitCommit)||!packet.compiledClosures.length||packet.compiledClosures.length>32||new Set(packet.compiledClosures.map(value=>value.name)).size!==packet.compiledClosures.length||packet.compiledClosures.some(value=>!isId(value.name)))throw new StoreError('CORRUPT_STORE');
  for(const hash of [packet.compiler.identity,packet.toolchain.identity,packet.dependencies.lockfileHash,packet.dependencies.vendorManifestHash,packet.dependencies.identity,packet.native.profileHash,packet.native.artifactManifestHash,packet.platform.identity])if(!requestFamilyDigest(hash))throw new StoreError('CORRUPT_STORE');
  const restore=packet.verifiedFreshRestore,closures=packet.compiledClosures.map(value=>({name:value.name,archive:{hash:value.archive.hash,byteLength:value.archive.byteLength},manifest:{hash:value.manifest.hash,byteLength:value.manifest.byteLength}}));
  if(restore.result!=='verified'||restore.sourceArchiveHash!==packet.sourceArchive.hash||restore.compiledClosureHash!==hashBytes(canonical(closures)))throw new StoreError('CORRUPT_STORE');
  for(const file of requestFamilyPacketFiles(packet))requestFamilyFileProof(file);
  const receipt=requestFamilyJSON(restore.receipt);
  if(receipt.kind!=='schema17-fresh-restore-1'||receipt.storageVersion!==17||receipt.result!=='verified'||receipt.sourceArchiveHash!==restore.sourceArchiveHash||receipt.compiledClosureHash!==restore.compiledClosureHash||receipt.toolchainIdentity!==packet.toolchain.identity||receipt.dependencyIdentity!==packet.dependencies.identity||receipt.nativeProfileHash!==packet.native.profileHash||receipt.platformIdentity!==packet.platform.identity||receipt.checks?.freshRestore!==true||receipt.checks?.openExistingSchema17!==true||receipt.checks?.replayByteIdentity!==true||receipt.checks?.networkEffects!==0)throw new StoreError('CORRUPT_STORE');
  return packet;
}
/** Paths are installation locations, never part of the executable identity. */
export function schema17PacketIdentity(packet:Schema17ExecutablePacket):string {
  const content=(value:any):any=>{
    if(!value||typeof value!=='object')return value;
    if(Array.isArray(value))return value.map(content);
    if(Object.keys(value).sort().join(',')==='byteLength,hash,path')return {hash:value.hash,byteLength:value.byteLength};
    return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,content(child)]));
  };return hashBytes(canonical(content(packet)));
}
function requestFamilyInstalledPacket(root:string,pin:Schema17ExecutablePin|null=requestFamilyExecutablePin()):Schema17ExecutablePacket {
  if(pin===null)throw new StoreError('UNSUPPORTED_STORAGE',{kind:'fields',issues:[{path:'storage.schemaVersion',code:'REQUEST_FAMILY_ROLLBACK_EXECUTABLE_REQUIRED'}]});
  if(pin.kind!=='schema17-executable-pin-1'||!isId(pin.packetId)||!requestFamilyDigest(pin.identityHash)||!requestFamilyDigest(pin.platform.identity)||pin.platform.os!==process.platform||pin.platform.arch!==process.arch)throw new StoreError('UNSUPPORTED_STORAGE');
  const directory=join(root,'rollback-executables',pin.packetId),path=join(directory,'packet.json');
  assertComponents(directory);assertPrivate(directory,true);const stat=assertPrivate(path,false);if(stat.size>65536)throw new StoreError('CORRUPT_STORE');
  const input=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),bytes=Buffer.alloc(stat.size);
  try{if(!sameFile(stat,fstatSync(input)))throw new StoreError('ROOT_UNSAFE');let offset=0;while(offset<bytes.length){const count=readSync(input,bytes,offset,bytes.length-offset,null);if(!count)throw new StoreError('CORRUPT_OBJECT');offset+=count;}}finally{closeSync(input);}
  const descriptor=requestFamilyJSON({path,hash:hashBytes(bytes),byteLength:String(bytes.length)}) as Schema17ExecutablePacket;
  if(descriptor.packetId!==pin.packetId||schema17PacketIdentity(descriptor)!==pin.identityHash||canonical(descriptor.platform)!==canonical(pin.platform))throw new StoreError('CORRUPT_STORE');
  // Installer writes fixed private filenames in this exact owned directory.
  // Never follow source-machine paths or an environment/global fallback.
  for(const file of requestFamilyPacketFiles(descriptor))if(dirname(file.path)!==directory)throw new StoreError('ROOT_UNSAFE');
  return requestFamilyPacket(descriptor);
}
export function assertRequestFamilyMigrationReady(version:number,root:string):void {
  if(version>=1&&version<=16&&process.platform==='linux')installedSchema16Maintenance(root);
  if(version===17)requestFamilyInstalledPacket(root);
}
function requestFamilyJSON(file:RequestFamilySealedFile):any {
  requestFamilyFileProof(file);if(BigInt(file.byteLength)>65536n)throw new StoreError('CORRUPT_STORE');
  const bytes=Buffer.alloc(Number(file.byteLength)),input=openSync(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{let offset=0;while(offset<bytes.length){const count=readSync(input,bytes,offset,bytes.length-offset,null);if(!count)throw new StoreError('CORRUPT_OBJECT');offset+=count;}}
  finally{closeSync(input);}
  if(hashBytes(bytes)!==file.hash)throw new StoreError('CORRUPT_OBJECT');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new StoreError('CORRUPT_OBJECT');}
}

/** Retain executable bytes inside this rollback packet. External producer paths
 * are prerequisites, never the only copies needed to recover this root. */
function copyRequestFamilyPacket(packet:Schema17ExecutablePacket,destination:string):Schema17ExecutablePacket {
  privateDirectory(destination);let index=0;
  const copy=(source:RequestFamilySealedFile):RequestFamilySealedFile=>{
    requestFamilyFileProof(source);
    const target={...source,path:join(destination,String(index++).padStart(3,'0')+'.sealed')};
    const input=openSync(source.path,constants.O_RDONLY|constants.O_NOFOLLOW),output=privateFile(target.path),block=Buffer.alloc(1048576);
    try{for(;;){const count=readSync(input,block);if(!count)break;let offset=0;while(offset<count){const n=writeSync(output,block,offset,count-offset,null);if(!n)throw new StoreError('STORAGE_FAILURE');offset+=n;}}fsyncSync(output);}
    finally{closeSync(input);closeSync(output);}
    requestFamilyFileProof(source);requestFamilyFileProof(target);return target;
  };
  const retained={...packet,sourceArchive:copy(packet.sourceArchive),sourceManifest:copy(packet.sourceManifest),compiledClosures:packet.compiledClosures.map(value=>({...value,archive:copy(value.archive),manifest:copy(value.manifest)})),verifiedFreshRestore:{...packet.verifiedFreshRestore,receipt:copy(packet.verifiedFreshRestore.receipt)}};
  syncDirectory(destination);return requestFamilyPacket(retained);
}

// Source-only cumulative proposal. This seal remains null until every slice's
// discriminants, typed edges and effective sources receive the central review.
// A non-null value must equal the exact manifest hash; no environment override.
export const EDITOR_SCHEMA18_CAPABILITY_MANIFEST = {
  kind:'editor-capability-manifest-1',storageVersion:18,projectionSchema:9,assetProjectionSchema:3,
  completePortableFormat:10,recoveryPortableFormat:11,
  capabilities:[
    'document-creation-v1','encoded-adoption-v1','local-queue-order-edit-v1',
    'oversized-import-derivation-v1','request-family-v45-v1',
    'request-text-treatment-v1','returned-description-text-v1','sanitized-recovery-copy-v1',
  ],
} as const;
export const EDITOR_SCHEMA18_CAPABILITY_HASH=hashBytes(canonical(EDITOR_SCHEMA18_CAPABILITY_MANIFEST));
export const EDITOR_SCHEMA18_CAPABILITY_SEAL:string|null='sha256:c2eb7167875862e82da5f86dc52238001c09852a25c62d2f1bf9be9a2c3f0752';
const editorCapability='editor-contracts-18-v1';
function editorRefuse(code:string):never{throw new StoreError('UNSUPPORTED_STORAGE',{kind:'fields',issues:[{path:'storage.schemaVersion',code}]});}
export function assertEditorSchema18Ready(seal:string|null=EDITOR_SCHEMA18_CAPABILITY_SEAL):void{
  if(seal!==EDITOR_SCHEMA18_CAPABILITY_HASH)editorRefuse('EDITOR_SCHEMA18_CAPABILITIES_UNSEALED');
}
/** Pure receipt comparison is also used by source fixtures. It grants no write
 * authority: the separate executable seal is required by constructor/migration. */
export function assertEditorSchema18Receipt(receipt:any):void{
  if(!receipt||receipt.from!==17||receipt.to!==18||receipt.capability!==editorCapability||
      receipt.capabilityHash!==EDITOR_SCHEMA18_CAPABILITY_HASH||!receipt.capabilityManifest||typeof receipt.capabilityManifest!=='object'||
      canonical(receipt.capabilityManifest)!==canonical(EDITOR_SCHEMA18_CAPABILITY_MANIFEST))
    editorRefuse('EDITOR_SCHEMA18_CAPABILITY_MISMATCH');
}
function editorCapabilityReceipt(){assertEditorSchema18Ready();return {capability:editorCapability,capabilityManifest:EDITOR_SCHEMA18_CAPABILITY_MANIFEST,capabilityHash:EDITOR_SCHEMA18_CAPABILITY_HASH};}
function editorSchema18Tables(db:DatabaseSync):void{
  // Added only inside the same transaction as the exact capability receipt.
  db.exec('CREATE TABLE raster_import_inspections (id TEXT PRIMARY KEY,json TEXT NOT NULL,session_hash TEXT NOT NULL,epoch TEXT NOT NULL) STRICT');
  db.exec(`CREATE INDEX queue_jobs_order_position ON queue_jobs(length(json_extract(json,'$.order.position')),json_extract(json,'$.order.position'),id);
CREATE INDEX queue_journal_job_creation ON queue_journal(seq) WHERE json_extract(json,'$.family')='job' AND json_extract(json,'$.event')='JobQueued';
CREATE INDEX queue_journal_order_epoch ON queue_journal(seq) WHERE json_extract(json,'$.event') IN ('QueueOrderInitialized','LocalQueueReordered');
CREATE INDEX queue_accepted_creation ON events_v2(length(seq),seq) WHERE json_extract(json,'$.type')='JobQueued';
CREATE INDEX queue_jobs_unordered ON queue_jobs(id) WHERE json_type(json,'$.order') IS NULL;`);
}

const editor18Kinds=new Set([
 'request-draft-v45-1','request-review-v45-1','provider-review-v45-1','v45-edit-inputs-1','v45-edit-mask-v1','generate-v45','transform-v45','inpaint-v45',
 'encoded-adoption-inputs-1','solid-background-v1','tp1-sanitized-recovery-v1',
 'request-review-text-1','text-treatment-review-intent-1','request-text-treatment-1','text-treatment-plan-1','text-treatment-inventory-1','text-treatment-source-subset-1',
 'text-treatment-adoption-choice-1','text-treatment-adoption-decision-1','text-treatment-provenance-1','candidate-text-treatment-1','candidate-text-treatment-preview-1',
 'returned-description-review-1','returned-description-selection-1','created-text-description-1','text-draft-3','local-queue-reorder-1','queue-order-edit-1',
 'raster-import-inspection-v1','decoded-derived-v1',
]);
const editor18Commands=new Set(['PrepareV45EditInputs','CreateDocument','SaveRecoveryCopy','CreateTextFromReturnedDescription','ReviewTextTreatment','ReorderLocalQueue','EditQueuedJob','InspectRasterOriginal']);
const editor18Events=new Set(['LocalQueueReordered','QueueDraftReplacementSaved','QueueOrderInitialized','RasterImportInspectionPrepared']);
const editorRasterPlans=new Set(['decoded-native','cp1-composition','cp1-layer-contribution-v1','authored-mask-v1','authored-mask-v2','authored-request-mask-v1','request-mask-resize','request-mask-binary-v1','request-source-transport-v1','request-preservation-v1','request-source-capture-v1','retained-candidate-v1','retained-text','frozen-png-export','frozen-image-export-v1','candidate-lettering-comparison-v1','v45-edit-inputs-1','v45-edit-mask-v1','solid-background-v1','decoded-derived-v1']);
const editorKindFamilies=[...editor18Kinds].filter(kind=>/-v?[0-9]+$/.test(kind)).map(kind=>kind.replace(/[0-9]+$/,''));
// Current split semantics are independent of the sealed schema18 capability.
const currentTextSplitKinds=new Set(['created-text-split-description-1','text-split-plan-1']);
const currentTextSplitKindFamilies=[...currentTextSplitKinds].map(kind=>kind.replace(/[0-9]+$/,''));

// Fixed owned scratch namespace, outside the store. Index scratch holds only
// hashes/ref descriptors; database scratch temporarily holds private store SQL
// bytes so WAL/hot-journal recovery cannot write into the original directory.
function editorScratchDirectory(root:string,purpose:'index'|'database'):{directory:string;close:()=>void}{
  const parent=join(realpathSync(tmpdir()),'ideogram-editor-schema-scans-'+String(process.getuid!())),source=realpathSync(root);
  // Environment-selected temp locations must never overlap the owned store,
  // including realpath aliases or a store placed under our scratch parent.
  if(parent===source||parent.startsWith(source+sep)||source.startsWith(parent+sep))throw new StoreError('ROOT_UNSAFE');
  assertComponents(dirname(parent));privateDirectory(parent);
  const entries=readdirSync(parent,{withFileTypes:true}).filter(entry=>entry.name!=='cursor').sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0),cursor=privateFile(join(parent,'cursor'));let offset=0;
  try{const size=fstatSync(cursor).size;if(size>32)throw new StoreError('ROOT_UNSAFE');if(size){const bytes=Buffer.alloc(size);if(readSync(cursor,bytes,0,size,0)!==size)throw new StoreError('ROOT_UNSAFE');const value=bytes.toString('ascii');if(/^(0|[1-9][0-9]*)$/.test(value)&&Number.isSafeInteger(Number(value)))offset=entries.length?Number(value)%entries.length:0;}
    const next=String(entries.length?(offset+Math.min(32,entries.length))%entries.length:0);writeSync(cursor,Buffer.from(next),0,Buffer.byteLength(next),0);ftruncateSync(cursor,Buffer.byteLength(next));
  }finally{closeSync(cursor);}
  for(let i=0;i<Math.min(32,entries.length);i++){
    const entry=entries[(offset+i)%entries.length];
    const match=/^scan-([1-9][0-9]*)-[A-Za-z0-9]{6}$/.exec(entry.name);if(!match||!entry.isDirectory())continue;
    const path=join(parent,entry.name);try{
      assertPrivate(path,true);const files=readdirSync(path);if(!files.includes('owner.json'))continue;
      const markerPath=join(path,'owner.json'),stat=assertPrivate(markerPath,false);if(stat.size>256)continue;
      const fd=openSync(markerPath,constants.O_RDONLY|constants.O_NOFOLLOW),bytes=Buffer.alloc(stat.size);try{if(!sameFile(stat,fstatSync(fd))||readSync(fd,bytes,0,bytes.length,0)!==bytes.length)continue;}finally{closeSync(fd);}
      const marker=JSON.parse(bytes.toString('utf8'));if(!['index','database'].includes(marker.purpose)||canonical(marker)!==canonical({kind:'editor-schema-scratch-1',purpose:marker.purpose,pid:Number(match[1])}))continue;
      const allowed=marker.purpose==='index'?['owner.json','scan.sqlite','scan.sqlite-journal']:['owner.json','metadata.sqlite','metadata.sqlite-wal','metadata.sqlite-shm','metadata.sqlite-journal'];if(files.some(name=>!allowed.includes(name)))continue;
      let dead=false;try{process.kill(Number(match[1]),0);}catch(error){dead=(error as NodeJS.ErrnoException).code==='ESRCH';}if(!dead)continue;
      for(const name of files)assertPrivate(join(path,name),false);rmSync(path,{recursive:true});
    }catch{/* Unknown/non-private/raced directories are left untouched. */}
  }
  const directory=mkdtempSync(join(parent,'scan-'+process.pid+'-'));assertPrivate(directory,true);
  try{
    const marker=openSync(join(directory,'owner.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{writeFileSync(marker,canonical({kind:'editor-schema-scratch-1',purpose,pid:process.pid}));fsyncSync(marker);}finally{closeSync(marker);}syncDirectory(directory);syncDirectory(parent);
    return {directory,close(){rmSync(directory,{recursive:true,force:true});}};
  }catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
}
function editorScanScratch(root:string):{db:DatabaseSync;close:()=>void}{
  const scratch=editorScratchDirectory(root,'index');let db:DatabaseSync|undefined;
  try{
    const path=join(scratch.directory,'scan.sqlite');closeSync(privateFile(path));db=new DatabaseSync(path,{allowExtension:false});
    db.exec(`PRAGMA journal_mode=OFF;PRAGMA synchronous=OFF;PRAGMA trusted_schema=OFF;PRAGMA temp_store=FILE;PRAGMA cache_size=-2048;
      CREATE TABLE identities(hash TEXT PRIMARY KEY,bytes TEXT NOT NULL,media TEXT NOT NULL) STRICT;
      CREATE TABLE visits(hash TEXT NOT NULL,kind TEXT NOT NULL,bytes TEXT NOT NULL,media TEXT NOT NULL,required INTEGER NOT NULL,done INTEGER NOT NULL,PRIMARY KEY(hash,kind)) STRICT;
      CREATE INDEX pending_visits ON visits(done);BEGIN;`);
    const index=db;return {db:index,close(){try{index.close();}finally{scratch.close();}}};
  }catch(error){try{db?.close();}finally{scratch.close();}throw error;}
}

/** The caller holds the exclusive writer/root lock. This is a stable capture
 * for compatibility inspection, never a live-backup API. No SQLite connection
 * touches the source until capability and rollback prerequisites have passed. */
export function editorSQLitePreflight(root:string,path:string):{db:DatabaseSync;checkSource:()=>void;close:()=>void}{
  const source=realpathSync(root);assertComponents(dirname(path));
  if(!path.startsWith(source+sep))throw new StoreError('ROOT_UNSAFE');
  const suffixes=['','-wal','-journal','-shm'] as const;
  const stamp=()=>suffixes.map(suffix=>{try{const s=assertPrivate(path+suffix,false);return {suffix,dev:s.dev,ino:s.ino,size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}});
  const before=stamp();if(!before[0])throw new StoreError('MISSING_OBJECT');
  const identity=canonical(before),checkSource=()=>{if(canonical(stamp())!==identity)throw new StoreError('ROOT_UNSAFE');};
  const scratch=editorScratchDirectory(root,'database');let db:DatabaseSync|undefined;
  try{
    // Reserve actual temporary bytes plus recovery growth and headroom. This
    // does not grant ledger/quota credit or change any owned-store accounting.
    const copied=before.slice(0,3).reduce((sum,item)=>sum+BigInt(item?.size??0),0n),fs=statfsSync(scratch.directory,{bigint:true});
    const needed=copied*2n+(copied+3n)/4n+67108864n;
    if(fs.bavail*fs.bsize<needed||(fs.blocks-fs.bavail)*10n>=fs.blocks*9n)throw new StoreError('CAPACITY');
    const block=Buffer.alloc(1048576);
    for(const item of before.slice(0,3)){
      if(!item)continue;checkSource();const input=openSync(path+item.suffix,constants.O_RDONLY|constants.O_NOFOLLOW);let output:number|undefined;
      const target=join(scratch.directory,'metadata.sqlite'+item.suffix),hash=createHash('sha256');
      try{
        const actual=fstatSync(input);if(actual.dev!==item.dev||actual.ino!==item.ino||actual.size!==item.size||actual.mtimeMs!==item.mtimeMs||actual.ctimeMs!==item.ctimeMs||actual.nlink!==1)throw new StoreError('ROOT_UNSAFE');
        output=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        let offset=0;while(offset<item.size){const n=readSync(input,block,0,Math.min(block.length,item.size-offset),offset);if(!n)throw new StoreError('CORRUPT_OBJECT');hash.update(block.subarray(0,n));let written=0;while(written<n){const count=writeSync(output,block,written,n-written,null);if(!count)throw new StoreError('STORAGE_FAILURE');written+=count;}offset+=n;}fsyncSync(output);
      }finally{closeSync(input);if(output!==undefined)closeSync(output);}
      requestFamilyFileProof({path:target,hash:'sha256:'+hash.digest('hex'),byteLength:String(item.size)});checkSource();
    }
    syncDirectory(scratch.directory);checkSource();
    // Writable only in the private copy: SQLite may reconstruct SHM or roll
    // back a copied hot journal. The original SHM is never opened or copied.
    db=new DatabaseSync(join(scratch.directory,'metadata.sqlite'),{allowExtension:false});
    db.exec('PRAGMA trusted_schema=OFF;PRAGMA cache_size=-2048');db.prepare('PRAGMA schema_version').get();db.exec('PRAGMA query_only=ON;BEGIN');for(const name of readdirSync(scratch.directory))assertPrivate(join(scratch.directory,name),false);checkSource();
    const reader=db;return {db:reader,checkSource,close(){try{if(reader.isTransaction)reader.exec('ROLLBACK');reader.close();}finally{scratch.close();}}};
  }catch(error){try{db?.close();}finally{scratch.close();}throw error;}
}

/** Read only typed envelopes and declared generated metadata. Authored text,
 * raw captions, font/profile/layout files and encoded originals are leaves. */
export function assertEditorSemanticCompatibility(db:DatabaseSync,root:string,version:number):void{
  const future=()=>editorRefuse('EDITOR_CONTRACTS_REQUIRE_MATCHING_EXECUTABLE_OR_VERIFIED_BACKUP');
  let snapshotProjection:number|null=null,snapshotDependencyFailure=false;
  const introduced=()=>{if(version<18||snapshotProjection!==null&&snapshotProjection<9)future();};
  const compositionTextIntroduced=()=>{if(version<19)future();};
  const textSplitIntroduced=()=>{if(version<19)future();};
  const names=new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row=>String(row.name)));
  const hasTable=(name:string)=>names.has(name);
  if(hasTable('raster_import_inspections'))introduced();
  const hasColumn=(table:string,column:string)=>hasTable(table)&&db.prepare(`PRAGMA table_info(${table})`).all().some(row=>row.name===column);
  type EdgeKind='metadata'|'image'|'raster'|'draft'|'text-draft'|'text-split-plan'|'treatment'|'composition'|'projection'|'composition-text-projection'|'snapshot';
  const scratch=editorScanScratch(root),index=scratch.db;
  try {
  let required=false,currentUI=false;
  const clearGraph=()=>index.exec('DELETE FROM visits;DELETE FROM identities');
  const owned=(hash:string,media:string)=>['roots','snapshot_roots','portable_pins'].some(table=>hasTable(table)&&!!db.prepare(`SELECT 1 FROM ${table} WHERE hash=? AND media_type=? LIMIT 1`).get(hash,media));
  const liveDocument=(id:unknown)=>isId(id)&&hasTable('documents')&&!!db.prepare('SELECT 1 FROM documents WHERE id=?').get(id)&&!(hasTable('candidate_document_tombstones')&&db.prepare('SELECT 1 FROM candidate_document_tombstones WHERE document_id=?').get(id));
  const json=(text:string)=>{try{return JSON.parse(text);}catch{throw new StoreError('CORRUPT_STORE');}};
  const edge=(ref:any,kind:EdgeKind='metadata',limit=65536)=>{
    if(!ref||typeof ref.hash!=='string'||!/^sha256:[a-f0-9]{64}$/.test(ref.hash)||typeof ref.byteLength!=='string'||!/^(0|[1-9][0-9]*)$/.test(ref.byteLength)||typeof ref.mediaType!=='string'||BigInt(ref.byteLength)>BigInt(Number.MAX_SAFE_INTEGER))throw new StoreError('CORRUPT_OBJECT');
    if(kind!=='snapshot'&&BigInt(ref.byteLength)>BigInt(limit))throw new StoreError('CORRUPT_OBJECT');
    // Saved drafts are exact text assets. All other declared generated edges
    // are JSON; a media relabel must not make an edge silently disappear.
    if(kind==='snapshot'?ref.mediaType!=='application/x-ndjson':['draft','text-draft'].includes(kind)?!['application/json','text/plain','text/plain;charset=utf-8'].includes(ref.mediaType):ref.mediaType!=='application/json')throw new StoreError('CORRUPT_OBJECT');
    const identity=index.prepare('SELECT bytes,media FROM identities WHERE hash=?').get(ref.hash);
    if(identity&&(identity.bytes!==ref.byteLength||identity.media!==ref.mediaType))throw new StoreError('CORRUPT_OBJECT');
    if(!identity)index.prepare('INSERT INTO identities VALUES (?,?,?)').run(ref.hash,ref.byteLength,ref.mediaType);
    const mustRead=required||owned(ref.hash,ref.mediaType),prior=index.prepare('SELECT required FROM visits WHERE hash=? AND kind=?').get(ref.hash,kind);
    if(prior){if(mustRead&&!prior.required)index.prepare('UPDATE visits SET required=1,done=0 WHERE hash=? AND kind=?').run(ref.hash,kind);return;}
    index.prepare('INSERT INTO visits VALUES (?,?,?,?,?,0)').run(ref.hash,kind,ref.byteLength,ref.mediaType,mustRead?1:0);
  };
  const walk=(value:any,depth=0):void=>{
    if(!value||typeof value!=='object')return;
    if(depth>128)throw new StoreError('CAPACITY');
    if(Array.isArray(value)){for(const child of value)walk(child,depth+1);return;}
    const kind=value.kind;
    if(typeof value.serializer==='string'&&value.serializer.startsWith('composition-text-')){
      if(value.serializer!=='composition-text-1')future();compositionTextIntroduced();
      try{validateCompositionTextReview(value);}catch{throw new StoreError('CORRUPT_OBJECT');}
    }
    if(editor18Kinds.has(kind)){introduced();if(value.schemaVersion!==undefined&&value.schemaVersion!==(kind==='text-draft-3'?3:1))future();}
    if(typeof kind==='string'&&currentTextSplitKindFamilies.some(prefix=>kind.startsWith(prefix))){if(!currentTextSplitKinds.has(kind))future();textSplitIntroduced();}
    if(typeof kind==='string'&&(kind.startsWith('request-draft-')||kind.startsWith('request-review-'))&&!['request-draft-1','request-review-1','request-draft-v45-1','request-review-v45-1','request-review-text-1'].includes(kind))future();
    if(typeof kind==='string'&&kind.startsWith('text-draft-')&&!['text-draft-1','text-draft-2','text-draft-3'].includes(kind))future();
    if(typeof kind==='string'&&editorKindFamilies.some(prefix=>kind.startsWith(prefix))&&!editor18Kinds.has(kind)&&!['text-draft-1','text-draft-2'].includes(kind))future();
    if(editor18Commands.has(value.type)||editor18Events.has(value.type)||value.kind==='image-edit'&&editor18Commands.has(value.operation))introduced();
    if(value.type==='SplitTextDraft'||value.kind==='image-edit'&&value.operation==='SplitTextDraft')textSplitIntroduced();
    if(value.type==='SplitTextDraft')edge(value.plan,'text-split-plan');
    if(value.type==='ReviewCandidatePlacement'&&value.preparation!==undefined){if(value.preparation!=='encoded-rebuild')future();introduced();}
    if(value.type==='PrepareRaster'&&value.importPlan!==undefined)introduced();
    if(['generate-v45','transform-v45','inpaint-v45'].includes(value.operation))introduced();
    if(typeof value.endpoint==='string'&&value.endpoint.startsWith('ideogram/v4.5')){
      if(!['ideogram/v4.5','ideogram/v4.5/edit'].includes(value.endpoint))future();introduced();
    }
    for(const field of ['contract','requestContract','resultContract'])if(typeof value[field]==='string'&&value[field].includes('ideogram-v45')){
      if(!['fal-ideogram-v45-generation-1','fal-ideogram-v45-edit-1','ideogram-v45-result-1'].includes(value[field]))future();introduced();
    }
    if(value.codec==='r16le-deflate-v1'||value.mediaType==='application/x-ideogram-r16le-deflate')introduced();
    if(typeof value.codec==='string'&&value.codec.startsWith('r16le-deflate-')&&value.codec!=='r16le-deflate-v1')future();
    if(value.protocolVersion===1&&(value.formatVersion!==undefined||value.documentSchema!==undefined)){
      if((value.formatVersion??0)>13||(value.documentSchema??0)>13)future();
      if((value.formatVersion??0)>=12||(value.documentSchema??0)>=12){compositionTextIntroduced();if(value.complete===false)future();}
      if((value.formatVersion??0)>=10||(value.documentSchema??0)>=10)introduced();
      if(value.formatVersion===11||value.documentSchema===11){if(value.complete!==false)future();}
    }
    if(value.status==='recovery-copy-ready'||value.reason==='INCOMPLETE_SANITIZED_RECOVERY_COPY')introduced();
    // Document metadata belongs to Documents, not arbitrary objects or ImageState.
    if(isId(value.id)&&typeof value.revision==='string'&&Array.isArray(value.orderedLayerIds)&&typeof value.historyHead==='string'&&value.metadata!==undefined){
      introduced();if(value.metadata?.schemaVersion!==1)future();
    }
    if(isId(value.id)&&value.review&&Array.isArray(value.attempts)&&typeof value.local==='string'){
      if(value.order!==undefined||value.ownerClientId!==undefined||value.replacementDraft!==undefined)introduced();
      if(value.order&&!['accepted','accepted-event','journal','journal-unplaced','legacy-id-order'].includes(value.order.origin))future();
    }
    if(value.protocolVersion===1&&typeof value.entityVersion==='string'&&typeof value.highWater==='string'&&value.projection?.kind==='inline'&&value.projection.value?.qualification){
      const role=value.projection.value.raster?.role;if(![2,3].includes(value.projectionSchema)||(value.projectionSchema===3)!==(role==='derived'))future();if(value.projectionSchema===3)introduced();
    }
    if(value.raster){
      if(value.raster.role==='derived')introduced();
      if(value.raster.manifest)edge(value.raster.manifest,'raster');
    }
    if(value.retainedMetadata)edge(value.retainedMetadata);
    if(value.state&&typeof value.semanticDigest==='string'&&'compositeAssetId'in value)edge(value.state,'image');
    const savedDraft=value.kind==='request'||value.kind==='text'&&typeof value.generation==='string'&&Object.hasOwn(value,'documentId')&&Object.hasOwn(value,'targetLayerId')&&Object.hasOwn(value,'expectedDocumentRevision')&&typeof value.status==='string';
    if((savedDraft&&isId(value.assetId))||(typeof kind==='string'&&kind.startsWith('request-review-')&&isId(value.draftAsset))){
      const assetId=savedDraft?value.assetId:value.draftAsset;
      const draftRequired=required||currentUI&&liveDocument(value.documentId);
      const row=hasTable('assets')?db.prepare('SELECT json FROM assets WHERE id=?').get(assetId):undefined;
      const imported=row??(hasTable('portable_rows')?db.prepare("SELECT json FROM portable_rows WHERE kind='asset' AND id=? LIMIT 1").get(assetId):undefined);
      if(!imported){if(draftRequired)throw new StoreError('MISSING_OBJECT');}else {const priorRequired=required;required=draftRequired;edge(json(String(imported.json)).blob,value.kind==='text'?'text-draft':'draft');required=priorRequired;}
    }
    if(value.source?.capture)edge(value.source.capture,'raster');
    if(value.capture?.hash&&value.pixels?.hash&&isId(value.assetId))edge(value.capture,'raster');
    if(value.composition?.value)edge(value.composition.value,'composition',1048576);
    if(value.mask?.plan&&value.mask?.pixels)edge(value.mask.plan,'raster');
    if(value.preparedInputs?.manifest){edge(value.preparedInputs.manifest,'raster');if(value.preparedInputs.source?.manifest)edge(value.preparedInputs.source.manifest,'raster');if(value.preparedInputs.mask?.manifest)edge(value.preparedInputs.mask.manifest,'raster');for(const part of value.preparedInputs.references??[])if(part.manifest)edge(part.manifest,'raster');}
    if(kind==='request-text-treatment-1')edge(value.plan,'treatment',524288);
    if(['candidate-text-treatment-1','candidate-text-treatment-preview-1'].includes(kind)){
      if(!value.plan||typeof value.plan.kind!=='string')throw new StoreError('CORRUPT_OBJECT');
      if(value.plan.kind!=='request-text-treatment-1')future();
      edge(value.plan.plan,'treatment',524288);
    }
    if(kind==='text-treatment-inventory-1'){
      if(value.schemaVersion!==1)future();edge(value.imageState,'image');
      if(value.composition?.value)edge(value.composition.value,'composition',1048576);
      for(const layer of value.layers??[]){if(layer.contribution?.manifest)edge(layer.contribution.manifest,'raster');if(layer.native?.source)edge(layer.native.source);}
    }
    if(kind==='text-treatment-plan-1'){
      if(typeof value.prompt?.mode==='string'&&value.prompt.mode.startsWith('composition-text')&&value.prompt.mode!=='composition-text')future();
      if(value.schemaVersion!==1)future();if(value.edit?.requestPlan)edge(value.edit.requestPlan);if(value.prompt?.mode==='composition-text'){compositionTextIntroduced();edge(value.prompt.projection,'composition-text-projection',524288);}else if(value.prompt?.projection)edge(value.prompt.projection,'projection',524288);
    }
    if(kind==='created-text-description-1'){if(value.schemaVersion!==1)future();edge(value.createdSource);}
    if(kind==='created-text-split-description-1'){
      if(value.schemaVersion!==1)future();try{validateReturnedTextSplitOrigin(value);}catch{throw new StoreError('CORRUPT_OBJECT');}
      edge(value.draft,'text-draft');edge(value.plan,'text-split-plan');
    }
    if(kind==='text-split-plan-1'){
      try{textSplitPlan(value);}catch{throw new StoreError('CORRUPT_OBJECT');}
      for(const part of value.parts)edge(part.candidate);
      // originalText and description.returnedPrompt are exact authored bytes.
    }
    if(kind==='retained-raster-metadata-1'){edge(value.manifest,'raster');if(value.previous)edge(value.previous);}
    if(kind==='adopted-candidate-lineage-1'&&value.result?.request?.specification){
      const request=value.result.request.specification;if(request.source?.capture)edge(request.source.capture,'raster');if(request.mask?.plan)edge(request.mask.plan,'raster');
    }
    if(kind==='cp1-contribution-stack-v1')for(const part of value.contributions??[])edge(part.manifest,'raster');
    if(value.format==='straight-srgb-rgba8'&&value.plan){
      if(![1,2,3].includes(value.schemaVersion)||!editorRasterPlans.has(value.plan.kind))future();
      const plan=value.plan;
      if(plan.kind==='retained-text')edge(plan.source);
      if(plan.kind==='retained-candidate-v1')edge(plan.lineage);
      if(plan.kind==='request-source-capture-v1'){edge(plan.capture.image.state,'image');if(plan.contributions)edge(plan.contributions);}
      if(plan.kind!=='retained-text')for(const field of ['source','candidate','mask','input'])if(plan[field]?.hash&&plan[field].mediaType==='application/json')edge(plan[field],'raster');
      if(['cp1-composition','cp1-layer-contribution-v1','candidate-lettering-comparison-v1'].includes(plan.kind))for(const ref of value.dependencies??[])if(ref.mediaType==='application/json')edge(ref,'raster');
      if(plan.kind==='v45-edit-inputs-1'){if(plan.mask?.manifest)edge(plan.mask.manifest,'raster');for(const part of plan.references??[])if(part.input?.manifest)edge(part.input.manifest,'raster');}
    }
    if(value.schemaVersion&&Array.isArray(value.layers)&&Number.isSafeInteger(value.width)&&Number.isSafeInteger(value.height)){
      if(![1,2,3,4,5].includes(value.schemaVersion))future();
      if(value.composition?.value)edge(value.composition.value,'composition',1048576);
      for(const layer of value.layers)if(layer.kind==='text'&&layer.source)edge(layer.source);
    }
    if(kind==='composition-version-1'&&value.schemaVersion!==1)future();
    if(value.adoptedLineage)edge(value.adoptedLineage);
    if(value.plan?.hash&&(value.kind==='candidate-adoption'||value.kind==='resample-image'||value.kind==='flattened-copy'))edge(value.plan);
    if(value.payload?.state&&typeof value.type==='string'&&['JobQueued','QueueStateChanged','LocalQueueReordered','CandidateStateChanged'].includes(value.type))edge(value.payload.state);
    // Root entries in history are generated state/plan/lineage metadata. Raw
    // arbitrary request caption refs are not visited simply for being JSON.
    if(value.kind==='image-edit'&&Array.isArray(value.roots))for(const ref of value.roots)if(ref.mediaType==='application/json')edge(ref);
    // Blob refs are leaves. Literal bytes and base64 parts are never reparsed
    // by generic recursion; snapshots below have a separate typed decoder.
    if(value.hash&&value.byteLength&&value.mediaType)return;
    for(const child of Object.values(value))if(child&&typeof child==='object')walk(child,depth+1);
  };
  const read=(ref:any,consume:(fd:number)=>void,mustRead=required)=>{
    const path=join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
    let before:ReturnType<typeof assertPrivate>;
    try{before=assertPrivate(path,false);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){if(!mustRead)return;throw new StoreError('MISSING_OBJECT');}throw error;}
    if(BigInt(before.size)!==BigInt(ref.byteLength))throw new StoreError('CORRUPT_OBJECT');
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256'),block=Buffer.alloc(65536);
    try{
      if(!sameFile(before,fstatSync(fd)))throw new StoreError('ROOT_UNSAFE');
      let offset=0;while(offset<before.size){const n=readSync(fd,block,0,Math.min(block.length,before.size-offset),offset);if(!n)throw new StoreError('CORRUPT_OBJECT');hash.update(block.subarray(0,n));offset+=n;}
      if('sha256:'+hash.digest('hex')!==ref.hash)throw new StoreError('CORRUPT_OBJECT');consume(fd);
      const after=assertPrivate(path,false);if(!sameFile(before,after)||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.size!==after.size)throw new StoreError('ROOT_UNSAFE');
    }finally{closeSync(fd);}
  };
  const drain=()=>{
    for(;;){const row=index.prepare('SELECT hash,kind,bytes,media,required FROM visits WHERE done=0 ORDER BY rowid DESC LIMIT 1').get();if(!row)break;
      index.prepare('UPDATE visits SET done=1 WHERE hash=? AND kind=?').run(row.hash,row.kind);
      const ref={hash:String(row.hash),byteLength:String(row.bytes),mediaType:String(row.media)},kind=row.kind as EdgeKind,mustRead=!!row.required;const previousRequired=required;required=mustRead;
      if(kind==='snapshot'){scanSnapshot(ref);required=previousRequired;continue;}
      read(ref,fd=>{const bytes=Buffer.alloc(Number(ref.byteLength));let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw new StoreError('CORRUPT_OBJECT');offset+=n;}
        let value:any;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new StoreError('CORRUPT_OBJECT');}
        if(kind==='raster'&&value?.format!=='straight-srgb-rgba8'||kind==='image'&&!Array.isArray(value?.layers)||kind==='draft'&&!['request-draft-1','request-draft-v45-1'].includes(value?.kind)||kind==='text-draft'&&!['text-draft-1','text-draft-2','text-draft-3'].includes(value?.kind)||kind==='text-split-plan'&&value?.kind!=='text-split-plan-1'||kind==='treatment'&&value?.kind!=='text-treatment-plan-1'||kind==='composition'&&value?.kind!=='composition-version-1'||kind==='projection'&&value?.serializer!=='caption-json-1'||kind==='composition-text-projection'&&value?.serializer!=='composition-text-1')future();walk(value);
      },mustRead);required=previousRequired;
    }
  };
  // Snapshots are optional replay accelerators. Inspect hash-verified future
  // semantics, but preserve the existing corrupt-copy fallback to prior/events.
  // Stream records and assemble only one bounded entity at a time.
  const scanSnapshot=(ref:any)=>{const previousProjection=snapshotProjection;try{read(ref,fd=>{
    const block=Buffer.alloc(65536);let offset=0,line=Buffer.alloc(0),header=false,parts:Buffer[]=[],partId='',partIndex=0,partCount=0,partBytes=0;
    const row=(bytes:Buffer)=>{
      if(bytes.length>16384)throw new StoreError('CORRUPT_OBJECT');let v:any;try{v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new StoreError('CORRUPT_OBJECT');}
      if(!header){if(v.kind!=='header'||!Number.isSafeInteger(v.projectionSchema)||v.projectionSchema<2)throw new StoreError('CORRUPT_OBJECT');if(!supportsProjectionSchema(v.projectionSchema))future();if(v.projectionSchema===9)introduced();snapshotProjection=v.projectionSchema;header=true;return;}
      if(v.kind!=='projection-part'||!['asset','document','history','checkpoint'].includes(v.entityType)||!isId(v.entityId)||!Number.isSafeInteger(v.partCount)||v.partCount<1||v.partCount>16||v.partIndex!==partIndex||typeof v.utf8Base64!=='string')throw new StoreError('CORRUPT_OBJECT');
      const id=v.entityType+':'+v.entityId;if(partIndex===0){partId=id;partCount=v.partCount;}else if(id!==partId||v.partCount!==partCount)throw new StoreError('CORRUPT_OBJECT');
      const decoded=Buffer.from(v.utf8Base64,'base64');if(decoded.toString('base64')!==v.utf8Base64)throw new StoreError('CORRUPT_OBJECT');parts.push(decoded);partBytes+=decoded.length;if(partBytes>65536)throw new StoreError('CORRUPT_OBJECT');partIndex++;
      if(partIndex===partCount){let entity:any;try{entity=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}catch{throw new StoreError('CORRUPT_OBJECT');}walk(entity);try{projectionEntity(snapshotProjection!,v.entityType,entity);}catch{throw new StoreError('CORRUPT_OBJECT');}try{drain();}catch(error){snapshotDependencyFailure=true;throw error;}clearGraph();parts=[];partIndex=0;partBytes=0;}
    };
    while(offset<Number(ref.byteLength)){const n=readSync(fd,block,0,Math.min(block.length,Number(ref.byteLength)-offset),offset);if(!n)throw new StoreError('CORRUPT_OBJECT');offset+=n;line=Buffer.concat([line,block.subarray(0,n)]);let end:number;while((end=line.indexOf(10))>=0){row(line.subarray(0,end));line=line.subarray(end+1);}if(line.length>16384)throw new StoreError('CORRUPT_OBJECT');}
    if(line.length||!header||partIndex!==0)throw new StoreError('CORRUPT_OBJECT');
  });}finally{snapshotProjection=previousProjection;}};
  const envelope=(text:string,context='',force?:boolean)=>{clearGraph();const value=json(text);currentUI=context==='ui_checkpoints';required=force??(['documents','history','checkpoints','queue_jobs'].includes(context)&&liveDocument(context==='documents'?value?.id:value?.documentId)||['history_preparations','portable_preparations'].includes(context)&&liveDocument(value?.command?.documentId??value?.document?.id));walk(value);drain();};

  const scanCapture=(value:any)=>{
    if(value?.capture===undefined)return;
    if(![undefined,2,11].includes(value.captureVersion)||!isId(value.capture)||!requestFamilyDigest(value.captureHash))future();
    if(value.captureVersion===11)introduced();
    const directory=join(root,'portable',value.capture),path=join(directory,'capture.sqlite');
    const canceled=hasTable('portable_cancellations')&&hasTable('portable_preparations')&&!!db.prepare('SELECT 1 FROM portable_cancellations c JOIN portable_preparations p ON p.id=c.id WHERE p.operation_id=? LIMIT 1').get(value.capture);
    const active=liveDocument(value.document?.id)&&!canceled;let stat:ReturnType<typeof assertPrivate>;
    try{assertComponents(directory);assertPrivate(directory,true);stat=assertPrivate(path,false);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&!active)return;throw error;}
    const proof={path,hash:value.captureHash,byteLength:String(stat.size)};requestFamilyFileProof(proof);
    // The sealed spool's hash binds the main file only; sidecar transactions
    // would be unbound observations. An empty/missing sidecar is harmless.
    for(const suffix of ['-wal','-journal'])try{if(assertPrivate(path+suffix,false).size)throw new StoreError('CORRUPT_OBJECT');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const inspection=editorSQLitePreflight(root,path),capture=inspection.db;
    try{
      const tables=new Set(capture.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row=>String(row.name)));
      // These are generated spool records. The refs table may include raw
      // captions/font/profile bytes and is deliberately not interpreted.
      for(const table of ['entities','events','transactions','payloads'])if(tables.has(table))
        for(const row of capture.prepare(`SELECT json FROM ${table}`).iterate())envelope(String(row.json),'portable_preparations',active);
      if(tables.has('portable_features'))for(const row of capture.prepare('SELECT version FROM portable_features').iterate()){
        const feature=Number(row.version);if(!Number.isSafeInteger(feature)||feature>13)future();if(feature>=10)introduced();if(feature>=12)compositionTextIntroduced();
      }
    }finally{inspection.close();}inspection.checkSource();
    requestFamilyFileProof(proof);const after=assertPrivate(path,false);if(!sameFile(stat,after)||stat.mtimeMs!==after.mtimeMs||stat.ctimeMs!==after.ctimeMs)throw new StoreError('ROOT_UNSAFE');
  };
  // Explicit column inventory, never a broad scan of arbitrary user tables.
  const columns:[string,string][]=[
    ...['commands','asset_preparations','raster_preparations','history_preparations','portable_preparations'].map(table=>[table,'canonical'] as [string,string]),
    ['commands','receipt'],['history_preparations','frozen'],['portable_preparations','frozen'],
    ...['events','events_v2','documents','checkpoints','assets','history','raster_reviews','raster_import_inspections','image_previews','image_edit_reviews','portable_rows','portable_reviews','portable_bundles','ui_checkpoints','ui_events','ui_receipts','queue_jobs','queue_journal','queue_outbox','candidate_jobs','candidates','candidate_private','candidate_journal'].map(table=>[table,'json'] as [string,string]),
  ];
  for(const [table,column] of columns)if(hasColumn(table,column))for(const row of db.prepare(`SELECT ${column} AS envelope${table==='portable_preparations'?',id AS preparation_id':''} FROM ${table}`).iterate()){
    const canceled=table==='portable_preparations'&&hasTable('portable_cancellations')&&!!db.prepare('SELECT 1 FROM portable_cancellations WHERE id=?').get(row.preparation_id!);
    envelope(String(row.envelope),table,canceled?false:undefined);if(table==='portable_preparations'&&column==='frozen')scanCapture(json(String(row.envelope)));
  }
  if(hasTable('snapshots'))for(const row of db.prepare('SELECT descriptor FROM snapshots').iterate()){
    snapshotDependencyFailure=false;try{const descriptor=json(String(row.descriptor));if(descriptor.content?.encoding!=='lp1-snapshot-jsonl')throw new StoreError('CORRUPT_STORE');clearGraph();required=false;edge(descriptor.content.blob,'snapshot');drain();}
    catch(error){if(snapshotDependencyFailure)throw error;if(!(error instanceof SyntaxError)&&!(error instanceof TypeError)&&(!(error instanceof StoreError)||!['CORRUPT_OBJECT','MISSING_OBJECT','CORRUPT_STORE','MALFORMED_REQUEST','PAYLOAD_TOO_LARGE'].includes(error.code)))throw error;/* Same unusable-snapshot fallback as RecoveryStore.latest(). Future semantics are never swallowed. */}
    finally{clearGraph();required=false;snapshotProjection=null;snapshotDependencyFailure=false;}
  }
  } finally {scratch.close();}
}
/** Compatibility alias for the frozen V45 source fixtures; no capability seal
 * or migration is conferred by directly calling the semantic inspector. */
export function assertV45LegacyCompatibility(db:DatabaseSync,root:string):void{assertEditorSemanticCompatibility(db,root,17);}
export function assertEditorStorageCompatibility(db:DatabaseSync,root:string,version:number):void{
  if(!Number.isInteger(version)||version<0||version>19)editorRefuse('USE_MATCHING_EXECUTABLE_OR_VERIFIED_BACKUP');
  if(version>=18){
    const table=db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get();if(!table)editorRefuse('EDITOR_SCHEMA18_CAPABILITY_MISMATCH');
    const row=db.prepare('SELECT receipt FROM schema_migrations WHERE version=18').get();let receipt:any;
    try{receipt=row?JSON.parse(String(row.receipt)):null;}catch{editorRefuse('EDITOR_SCHEMA18_CAPABILITY_MISMATCH');}
    assertEditorSchema18Receipt(receipt);
    if(version===19){const row19=db.prepare('SELECT receipt FROM schema_migrations WHERE version=19').get();let receipt19:any;try{receipt19=row19?JSON.parse(String(row19.receipt)):null;}catch{editorRefuse('COMPOSITION_TEXT_SCHEMA19_CAPABILITY_MISMATCH');}assertCompositionTextSchema19Receipt(receipt19);}
  }
  // user_version=0 is not proof of an empty database. An interrupted or
  // mislabeled existing root must pass the same typed-reader fence as every
  // other supported version; a genuinely empty database has nothing to scan.
  assertEditorSemanticCompatibility(db,root,version);
  assertEditorSchema18Ready();assertCompositionTextSchema19Ready();
}

function digest(db: DatabaseSync, table: string): { hash: string; count: string } {
  const h = createHash('sha256'); let n = 0n;
  const order = db.prepare(`PRAGMA table_info(${table})`).all().length === 1 ? '1' : '1,2';
  for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) { h.update(canonical(row) + '\n'); n++; }
  return { hash: h.digest('hex'), count: String(n) };
}
// Additive migration: the v1 events table and its immutable triggers remain as
// rollback evidence. The active v2 log is a validated copy, activated by the
// schema-version transaction. No prior row, byte identity or root is removed.
export function extendSchema(db: DatabaseSync, root: string, oldVersion: number, quotaBytes?: string): void {
  if (oldVersion >= 2) return;
  let backup: string | null = null; let manifest: Record<string, unknown> = {};
  if (oldVersion === 1) {
    const stats = statfsSync(root,{bigint:true});
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    if (stats.bavail * stats.bsize < size + (size + 3n)/4n + 1073741824n + 67108864n ||
        (stats.blocks-stats.bavail)*10n >= stats.blocks*9n ||
        (quotaBytes && (inspectTree(root) + size + (size+3n)/4n + 67108864n > BigInt(quotaBytes) || inspectTree(root)*10n >= BigInt(quotaBytes)*9n))) throw new StoreError('CAPACITY');
    backup = `schema1-backup-${randomUUID()}.sqlite`;
    const path = join(root, backup);
    // VACUUM INTO accepts an empty destination. Precreate it privately; a worker
    // must not depend on or change the process-wide umask.
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok') throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); } syncDirectory(root);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE events_v2 (seq TEXT PRIMARY KEY, transaction_id TEXT NOT NULL,
      command_id TEXT NOT NULL REFERENCES commands(id) DEFERRABLE INITIALLY DEFERRED, json TEXT NOT NULL) STRICT;
      CREATE INDEX events_v2_transaction ON events_v2(transaction_id);
      CREATE INDEX events_v2_order ON events_v2(length(seq),seq);
      INSERT INTO events_v2 SELECT * FROM events;
      CREATE TRIGGER events_v2_immutable_update BEFORE UPDATE ON events_v2 BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER events_v2_immutable_delete BEFORE DELETE ON events_v2 BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TABLE snapshots (id TEXT PRIMARY KEY, seq TEXT NOT NULL, descriptor TEXT NOT NULL, projection_hash TEXT NOT NULL, roots_hash TEXT NOT NULL) STRICT;
      CREATE TABLE snapshot_roots (snapshot_id TEXT NOT NULL REFERENCES snapshots(id), owner TEXT NOT NULL, hash TEXT NOT NULL REFERENCES objects(hash), media_type TEXT NOT NULL, PRIMARY KEY(snapshot_id,owner,hash)) STRICT;
      CREATE TABLE client_bindings (cookie_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, expires TEXT NOT NULL) STRICT;
      CREATE TABLE read_releases (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, epoch TEXT NOT NULL) STRICT;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, receipt TEXT NOT NULL) STRICT;`);
    if (canonical(digest(db, 'events')) !== canonical(digest(db, 'events_v2'))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (2,?)').run(canonical({ from: oldVersion, to: 2,
      strategy: 'additive-copy-validate-transactional-activation', code: 'lp1-storage-v2', backup, manifest }));
    db.exec('PRAGMA user_version=2'); db.exec('COMMIT'); syncDirectory(root);
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function assetSchema(db: DatabaseSync, root: string, quotaBytes?: string, fresh = false) {
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 3) return;
  const tables = ['meta','objects','commands','events','events_v2','documents','history','checkpoints','roots','snapshots','snapshot_roots','client_bindings','read_releases','schema_migrations'];
  const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
  const stats = statfsSync(root,{bigint:true}); const required=size+(size+3n)/4n+1073741824n+67108864n;
  if(!fresh&&(stats.bavail*stats.bsize<required||(stats.blocks-stats.bavail)*10n>=stats.blocks*9n||
    (quotaBytes && inspectTree(root)+required>BigInt(quotaBytes)))) throw new StoreError('CAPACITY');
  const backup=fresh?null:`schema2-backup-${randomUUID()}.sqlite`;const manifest: Record<string,unknown>={};
  if(backup){const path=join(root,backup);closeSync(privateFile(path));
  db.prepare('VACUUM INTO ?').run(path);assertPrivate(path,false);
  const saved=new DatabaseSync(path,{readOnly:true,allowExtension:false});
  try {
    if(saved.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok')throw new StoreError('CORRUPT_STORE');
    for(const table of tables){const before=digest(db,table);if(canonical(before)!==canonical(digest(saved,table)))throw new StoreError('CORRUPT_STORE');manifest[table]=before;}
  } finally {saved.close();}
  const fd=privateFile(path);try{fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(root);}
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE staged_assets (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT NOT NULL, filename TEXT NOT NULL UNIQUE) STRICT;
      CREATE INDEX staged_recoverable ON staged_assets(id) WHERE json_extract(json,'$.state')!='finalized';
      CREATE TABLE transfer_reviews (id TEXT PRIMARY KEY, json TEXT NOT NULL, session_hash TEXT NOT NULL, epoch TEXT NOT NULL) STRICT;
      CREATE TABLE asset_preparations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, original TEXT NOT NULL, canonical TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE, staging_id TEXT NOT NULL UNIQUE, staging_version TEXT NOT NULL, phase TEXT NOT NULL) STRICT;
      CREATE TABLE assets (id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
      CREATE TABLE asset_dependencies (asset_id TEXT NOT NULL REFERENCES assets(id), hash TEXT NOT NULL REFERENCES objects(hash), PRIMARY KEY(asset_id,hash)) STRICT;`);
    db.prepare('INSERT INTO schema_migrations VALUES (3,?)').run(canonical({from:2,to:3,strategy:'additive-verified-backup-transactional-activation',backup,manifest}));
    db.exec('PRAGMA user_version=3; COMMIT');syncDirectory(root);
  } catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
}

export function rasterSchema(db: DatabaseSync, root: string, quotaBytes?: string, fresh = false) {
  if(Number(db.prepare('PRAGMA user_version').get()!.user_version)>=4)return;
  const tables=['meta','objects','commands','events','events_v2','documents','history','checkpoints','roots','snapshots','snapshot_roots','client_bindings','read_releases','schema_migrations','staged_assets','transfer_reviews','asset_preparations','assets','asset_dependencies'];
  const size=BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count)*Number(db.prepare('PRAGMA page_size').get()!.page_size));
  const fs=statfsSync(root,{bigint:true}),required=size+(size+3n)/4n+1073741824n+67108864n;
  if(!fresh&&(fs.bavail*fs.bsize<required||(fs.blocks-fs.bavail)*10n>=fs.blocks*9n||(quotaBytes&&inspectTree(root)+required>BigInt(quotaBytes))))throw new StoreError('CAPACITY');
  const backup=fresh?null:`schema3-backup-${randomUUID()}.sqlite`,manifest:Record<string,unknown>={};
  if(backup){const path=join(root,backup);closeSync(privateFile(path));db.prepare('VACUUM INTO ?').run(path);assertPrivate(path,false);
    const saved=new DatabaseSync(path,{readOnly:true,allowExtension:false});try{if(saved.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok')throw new StoreError('CORRUPT_STORE');
      for(const table of tables){const before=digest(db,table);if(canonical(before)!==canonical(digest(saved,table)))throw new StoreError('CORRUPT_STORE');manifest[table]=before;}
    }finally{saved.close();}const fd=privateFile(path);try{fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(root);
  }
  db.exec('BEGIN IMMEDIATE');try{
    db.exec(`CREATE TABLE raster_preparations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, original TEXT NOT NULL, canonical TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, phase TEXT NOT NULL) STRICT;
      CREATE TABLE raster_reviews (id TEXT PRIMARY KEY, json TEXT NOT NULL, session_hash TEXT NOT NULL, epoch TEXT NOT NULL) STRICT;`);
    db.prepare('INSERT INTO schema_migrations VALUES (4,?)').run(canonical({from:3,to:4,strategy:'additive-verified-backup-transactional-activation',backup,manifest}));
    db.exec('PRAGMA user_version=4; COMMIT');syncDirectory(root);
  }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
}

// Schema 5 changes persisted preparation semantics, not table layout. Schema-4
// writers must refuse this root before replay, scheduling or incrementing epoch.
// A 7388d1e schema-4 root may already contain pending approvals: preserve those
// bytes, but never claim that its rollback copy is usable by dfa383d.
export function approvalSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'raster-pending-approval-v1';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 5) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=5').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = ['meta','objects','commands','events','events_v2','documents','history','checkpoints','roots',
    'snapshots','snapshot_roots','client_bindings','read_releases','schema_migrations','staged_assets','transfer_reviews',
    'asset_preparations','assets','asset_dependencies','raster_preparations','raster_reviews'];
  let approvals = 0;
  for (const row of db.prepare('SELECT * FROM raster_preparations').iterate()) {
    try {
      const request = parseCommand(Buffer.from(String(row.original)));
      if (request.command.commandId !== row.id || canonical(request) !== row.canonical ||
          hashBytes(String(row.canonical)) !== row.hash || !isId(row.operation_id) ||
          !['preparing','waiting-for-resources'].includes(String(row.phase)) ||
          !['PrepareRaster','ApproveRaster','ComposeRaster','ExportRaster'].includes(request.command.body.type)) throw new Error();
      if (request.command.body.type === 'ApproveRaster') approvals++;
    } catch { throw new StoreError('CORRUPT_STORE'); }
  }
  const compatibleExecutable = approvals ? '7388d1e625a6ac2c563bc64cca6318d264649acc' : 'dfa383d56d21bc9c7bb40248db8a503fe33e6e46';
  const backup = fresh ? null : `schema4-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('approval-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('approval-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 4) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 4,
        compatibleExecutable, pendingApprovals: approvals, manifest,
        retainedDirectories: ['objects','staging','uploads'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('approval-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (5,?)').run(canonical({ from:4, to:5, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable, pendingApprovals: approvals } : null }));
    db.exec('PRAGMA user_version=5');
    barrier('approval-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('approval-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

// History, preparation and UI semantics require explicit old-writer refusal.
export function historySchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'image-history-ui-v1';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 6) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=6').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = ['meta','objects','commands','events','events_v2','documents','history','checkpoints','roots',
    'snapshots','snapshot_roots','client_bindings','read_releases','schema_migrations','staged_assets','transfer_reviews',
    'asset_preparations','assets','asset_dependencies','raster_preparations','raster_reviews'];
  const compatibleExecutable = '92e5247ed3279f25292f8e312661bf3b12deffe7';
  const backup = fresh ? null : `schema5-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('history-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('history-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 5) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 5,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('history-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (6,?)').run(canonical({ from:5, to:6, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec(`CREATE TABLE history_preparations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, original TEXT NOT NULL, canonical TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, phase TEXT NOT NULL, frozen TEXT NOT NULL) STRICT;
      CREATE TABLE image_previews (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, client_id TEXT NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE TABLE image_edit_reviews (id TEXT PRIMARY KEY, json TEXT NOT NULL, session_hash TEXT NOT NULL, epoch TEXT NOT NULL) STRICT;
      CREATE TABLE ui_checkpoints (client_id TEXT NOT NULL, session_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(client_id,session_id)) STRICT;
      CREATE TABLE ui_events (client_id TEXT NOT NULL, session_id TEXT NOT NULL, seq TEXT NOT NULL, recorded_at TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(client_id,session_id,seq)) STRICT;
      CREATE TABLE ui_receipts (client_id TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(client_id,id)) STRICT;
      CREATE INDEX history_parent_branch ON history(json_extract(json,'$.parent'),json_extract(json,'$.branchId'));
      CREATE INDEX history_document_page ON history(document_id,id);
      CREATE INDEX checkpoints_document_page ON checkpoints(document_id,id);
      CREATE INDEX commands_document_layer ON commands(json_extract(canonical,'$.command.documentId'),json_extract(canonical,'$.command.body.layerId'));
      CREATE INDEX commands_document_new_layer ON commands(json_extract(canonical,'$.command.documentId'),json_extract(canonical,'$.command.body.newLayerId'));
      PRAGMA user_version=6`);
    barrier('history-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('history-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function portableSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'portable-copy-v1';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 7) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=7').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = 'd84c1de55709bbd957222cac854905c41583a4e4';
  const backup = fresh ? null : `schema6-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('portable-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('portable-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 6) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 6,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('portable-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (7,?)').run(canonical({ from:6, to:7, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec(`CREATE TABLE portable_preparations (id TEXT PRIMARY KEY,hash TEXT NOT NULL,original TEXT NOT NULL,canonical TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,phase TEXT NOT NULL,frozen TEXT NOT NULL,confirmed_at INTEGER NOT NULL,failure TEXT) STRICT;
      CREATE TABLE portable_pins (operation_id TEXT NOT NULL,hash TEXT NOT NULL REFERENCES objects(hash),media_type TEXT NOT NULL,PRIMARY KEY(operation_id,hash)) STRICT;
      CREATE TABLE portable_bundles (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,document_id TEXT NOT NULL,json TEXT NOT NULL) STRICT;
      CREATE TABLE portable_reviews (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,session_hash TEXT NOT NULL,epoch TEXT NOT NULL,json TEXT NOT NULL) STRICT;
      CREATE TABLE portable_namespaces (id TEXT PRIMARY KEY,document_id TEXT NOT NULL UNIQUE,source TEXT NOT NULL) STRICT;
      CREATE TABLE portable_rows (namespace TEXT NOT NULL REFERENCES portable_namespaces(id),kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(namespace,kind,id)) STRICT;
      CREATE TABLE portable_quarantined_hashes (hash TEXT PRIMARY KEY,reason TEXT NOT NULL) STRICT;
      CREATE TABLE portable_cancellations (id TEXT PRIMARY KEY,reason TEXT NOT NULL) STRICT;
      CREATE TABLE portable_review_sources (id TEXT PRIMARY KEY,staging_id TEXT NOT NULL,version TEXT NOT NULL,stamp TEXT NOT NULL) STRICT;
      CREATE TABLE portable_review_maps (review_id TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,local_id TEXT NOT NULL,PRIMARY KEY(review_id,kind,source_id)) STRICT;
      CREATE TABLE portable_maps (namespace TEXT NOT NULL REFERENCES portable_namespaces(id),kind TEXT NOT NULL,source_id TEXT NOT NULL,local_id TEXT NOT NULL,PRIMARY KEY(namespace,kind,source_id)) STRICT;
      PRAGMA user_version=7`);
    barrier('portable-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('portable-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function portableTransactionSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'portable-copy-v2-transaction-bounds';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 8) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=8').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = 'd4ed76148999978565ca8b37d27612f5b3faa591';
  const backup = fresh ? null : `schema7-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('portable-transaction-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('portable-transaction-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 7) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 7,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('portable-transaction-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (8,?)').run(canonical({ from:7, to:8, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec('CREATE INDEX events_v2_transaction_bounds ON events_v2(transaction_id,length(seq),seq); PRAGMA user_version=8');
    barrier('portable-transaction-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('portable-transaction-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function textSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'durable-text-v1-pf3-projection4';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 9) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=9').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = 'dcd5f11dbd57cd7ed00c8ddf410857ce4700440e';
  const backup = fresh ? null : `schema8-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('text-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('text-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 8) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 8,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('text-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (9,?)').run(canonical({ from:8, to:9, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec('CREATE TABLE text_admissions (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,session_hash TEXT NOT NULL,epoch TEXT NOT NULL) STRICT; PRAGMA user_version=9');
    barrier('text-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('text-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function maskSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'local-masks-v1-pf4-projection5';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 10) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=10').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = '4b2c82ccc41dd72c3f83480f23481b7b62135d23';
  const backup = fresh ? null : `schema9-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('mask-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('mask-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 9) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 9,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('mask-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (10,?)').run(canonical({ from:9, to:10, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec('PRAGMA user_version=10');
    barrier('mask-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('mask-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function retainedMaskSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'retained-mask-grids-v1-pf5-projection6';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 11) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=11').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = 'ecbcc79e9fa8e89acf84c2bb02831b780582ed88';
  const backup = fresh ? null : `schema10-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('retained-mask-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('retained-mask-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 10) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 10,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('retained-mask-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (11,?)').run(canonical({ from:10, to:11, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec('PRAGMA user_version=11');
    barrier('retained-mask-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('retained-mask-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function textPlacementSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'text-placement-v1-pf6-projection7';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 12) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=12').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = 'd3c6046a44d29d89ccdcb219cc37d40f02bad84f';
  const backup = fresh ? null : `schema11-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('text-placement-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('text-placement-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 11) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 11,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('text-placement-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (12,?)').run(canonical({ from:11, to:12, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec('PRAGMA user_version=12');
    barrier('text-placement-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('text-placement-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function compositionSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'composition-v1-pf7-projection8';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 13) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=13').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = 'd3b8e5f5ec4568547f21a2826792450367144a17';
  const backup = fresh ? null : `schema12-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('composition-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('composition-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 12) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 12,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('composition-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (13,?)').run(canonical({ from:12, to:13, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec('PRAGMA user_version=13');
    barrier('composition-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('composition-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function queueSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'queue-outbox-sg1-v1';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 14) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=14').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = '92688fb71a75870f0f9ad2d48c7b95e55c2581fc';
  const backup = fresh ? null : `schema13-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('queue-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('queue-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 13) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 13,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('queue-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (14,?)').run(canonical({ from:13, to:14, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec(`CREATE TABLE queue_jobs (id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
      CREATE TABLE spend_sessions (id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
      CREATE TABLE queue_outbox (attempt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE TABLE queue_journal (seq INTEGER PRIMARY KEY, json TEXT NOT NULL) STRICT;
      CREATE TRIGGER queue_journal_update BEFORE UPDATE ON queue_journal BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER queue_journal_delete BEFORE DELETE ON queue_journal BEGIN SELECT RAISE(ABORT,'immutable'); END;
      PRAGMA user_version=14;`);
    barrier('queue-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('queue-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function candidateSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'retained-candidates-v1';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 15) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=15').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = '9764b03ae889ae2fe2cf5d38e9e8e66bd6cf2eb4';
  const backup = fresh ? null : `schema14-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('candidate-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('candidate-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 14) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 14,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable','backend-transport'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('candidate-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (15,?)').run(canonical({ from:14, to:15, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec(`CREATE TABLE candidate_document_tombstones (document_id TEXT PRIMARY KEY, generation TEXT NOT NULL) STRICT;
      CREATE TABLE candidate_jobs (job_id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
      CREATE TABLE candidates (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, job_id TEXT NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE TABLE candidate_private (id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
      CREATE TABLE candidate_journal (seq INTEGER PRIMARY KEY, family TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE TRIGGER candidate_journal_update BEFORE UPDATE ON candidate_journal BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER candidate_journal_delete BEFORE DELETE ON candidate_journal BEGIN SELECT RAISE(ABORT,'immutable'); END;
      PRAGMA user_version=15;`);
    barrier('candidate-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('candidate-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function deletionSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  const capability = 'recovery-deletion-v1';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 16) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=16').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    return;
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  const compatibleExecutable = '086c9a677512f1faae98f9e947084ffb93c09431';
  const backup = fresh ? null : `schema15-backup-${randomUUID()}.sqlite`;
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const fs = statfsSync(root, { bigint: true }), required = size + (size+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('deletion-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('deletion-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 15) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 15,
        compatibleExecutable, manifest,
        retainedDirectories: ['objects','staging','uploads','portable','backend-transport'],
        recovery: 'Copy the backup database and retained directories into a separate owner-only root. Use only the named compatible executable. Keep this root and all prior backups unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('deletion-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // No pending request, event, projection, receipt or root is transformed.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (16,?)').run(canonical({ from:15, to:16, capability,
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { compatibleExecutable,  } : null }));
    db.exec(`CREATE TABLE deletion_plans (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, client_id TEXT NOT NULL, json TEXT NOT NULL, owners TEXT NOT NULL) STRICT;
      CREATE TABLE deletion_receipts (document_id TEXT PRIMARY KEY, json TEXT NOT NULL) STRICT;
      CREATE TABLE deletion_objects (document_id TEXT NOT NULL, hash TEXT NOT NULL, byte_length TEXT NOT NULL, media_type TEXT NOT NULL, state TEXT NOT NULL, generation TEXT NOT NULL, PRIMARY KEY(document_id,hash)) STRICT;
      CREATE TABLE deletion_backup_files (path TEXT PRIMARY KEY) STRICT;
      CREATE TABLE deletion_work (path TEXT PRIMARY KEY, document_id TEXT NOT NULL) STRICT;
      CREATE TABLE deletion_files (document_id TEXT NOT NULL,path TEXT NOT NULL,bytes TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(document_id,path)) STRICT;
      CREATE TABLE deletion_backup_pins (hash TEXT PRIMARY KEY) STRICT;
      INSERT INTO deletion_backup_pins SELECT DISTINCT hash FROM roots WHERE 0;
      PRAGMA user_version=16;`);
    if(backup){db.exec('INSERT OR IGNORE INTO deletion_backup_pins SELECT DISTINCT hash FROM roots');try{for(const name of readdirSync(join(root,'backend-transport')))db.prepare('INSERT INTO deletion_backup_files VALUES (?)').run(join(root,'backend-transport',name));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    barrier('deletion-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('deletion-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

// Development builds wrote some P2 records before their storage-version fence.
// Inspect them on the constructor's read-only connection; a backup of those
// records cannot truthfully promise readability by the accepted schema16 binary.
export function assertP2LegacyCompatibility(db: DatabaseSync, root: string): void {
  const refuse = (): never => { throw new StoreError('UNSUPPORTED_STORAGE', {kind:'fields',issues:[
    {path:'storage.schemaVersion',code:'P2_DEVELOPMENT_SCHEMA_REQUIRES_MATCHING_EXECUTABLE_OR_VERIFIED_BACKUP'},
  ]}); };
  const newCommands = new Set(['PrepareRequestSource','PrepareRequestMask','PrepareCandidateAdoption','AdoptCandidate','ReviewCandidatePlacement','AdoptReviewedCandidate','RegisterAdapterVersion','PreviewAdapterDeletion','DeleteAdapterVersion']);
  for (const table of ['commands','asset_preparations','raster_preparations','history_preparations','portable_preparations']) {
    for (const row of db.prepare(`SELECT canonical FROM ${table}`).iterate()) {
      if (newCommands.has(JSON.parse(String(row.canonical)).command?.body?.type)) refuse();
    }
  }
  for (const row of db.prepare('SELECT json FROM staged_assets').iterate()) if (JSON.parse(String(row.json)).purpose==='adapter') refuse();
  const metadata = (ref: any): any => {
    if (!ref || !/^sha256:[a-f0-9]{64}$/.test(ref.hash) || !/^(0|[1-9][0-9]*)$/.test(ref.byteLength) || BigInt(ref.byteLength)>65536n) return null;
    const path = join(root,'objects','sha256',ref.hash.slice(7,9),ref.hash.slice(7));
    let before: ReturnType<typeof assertPrivate>;
    try { before = assertPrivate(path,false); } catch (error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return null; throw error; }
    if (before.size!==Number(ref.byteLength)) throw new StoreError('CORRUPT_OBJECT');
    const input = openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW), bytes = Buffer.alloc(Number(ref.byteLength));
    try {
      if (!sameFile(before,fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      let offset = 0;
      while (offset<bytes.length) { const n=readSync(input,bytes,offset,bytes.length-offset,null); if (!n) throw new StoreError('CORRUPT_OBJECT'); offset+=n; }
    } finally { closeSync(input); }
    const after = assertPrivate(path,false);
    if (!sameFile(before,after) || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs || hashBytes(bytes)!==ref.hash) throw new StoreError('CORRUPT_OBJECT');
    try { return JSON.parse(bytes.toString('utf8')); } catch { return null; }
  };
  const newPlans = new Set(['request-source-capture-v1','authored-request-mask-v1','request-mask-binary-v1','request-source-transport-v1','request-preservation-v1','retained-candidate-v1','frozen-image-export-v1']);
  const shape = (value: any): void => {
    if (!value || typeof value!=='object') return;
    if (['AdoptCandidate','AdoptReviewedCandidate'].includes(value.operation) || value.kind==='candidate-adoption' || value.kind==='adopted-candidate-lineage-1' || value.kind==='candidate-placement-review-1' || value.kind==='retained-raster-metadata-1' || value.retainedMetadata!==undefined ||
        ['pending-adapter','adapter-version','adapter-deletion','canonical-jpeg'].includes(value.qualification) || ['ExportDocument','ExportRaster'].includes(value.type)&&value.options!==undefined) refuse();
    if (value.kind==='request-draft-1' && (value.requestMaskDraft!==undefined || value.source?.capture!==undefined || value.mask?.requestPlan!==undefined || value.mask?.binding!==undefined || value.mask?.cropAcknowledged!==undefined)) refuse();
    if (value.raster?.manifest) {
      const manifest = metadata(value.raster.manifest);
      if (newPlans.has(manifest?.plan?.kind) || manifest?.plan?.decodeTransport!==undefined) refuse();
    }
    // An arbitrary caption can contain JSON that resembles a future draft. Only
    // an authoritative saved-draft attachment gives those bytes draft semantics.
    if (value.kind==='request' && isId(value.assetId)) {
      const row = db.prepare("SELECT json FROM assets WHERE id=? UNION ALL SELECT json FROM portable_rows WHERE kind='asset' AND id=? LIMIT 1").get(value.assetId,value.assetId);
      if (row) { const draft=metadata(JSON.parse(String(row.json)).blob); if (draft?.kind==='request-draft-1') shape(draft); }
    }
    // Covers direct events/projections, imported namespace entities, and frozen
    // queued request records without treating arbitrary text strings as code.
    for (const child of Object.values(value)) if (child && typeof child==='object') shape(child);
  };
  for (const table of ['events_v2','assets','history','image_previews','portable_rows','ui_checkpoints','ui_events','queue_jobs','queue_journal']) {
    for (const row of db.prepare(`SELECT json FROM ${table}`).iterate()) shape(JSON.parse(String(row.json)));
  }
}

// P2 extends persisted raster plans, adoption history and adapter assets, and
// adds backend-only ownership of locally adopted raw evidence. Older writers
// must refuse the root before replay or epoch changes: interpreting these
// records as corrupt is not a version fence.
function candidatePreservationIndex(db:DatabaseSync){
  db.exec('CREATE INDEX IF NOT EXISTS roots_hash ON roots(hash)');
  db.exec(`CREATE INDEX IF NOT EXISTS assets_preservation_inputs ON assets (
    json_extract(json,'$.raster.pipeline'),json_extract(json,'$.raster.sourceAssetIds'),id
  ) WHERE json_extract(json,'$.qualification')='canonical-raster'
    AND json_extract(json,'$.safety')='safe' AND json_extract(json,'$.availability')='available'
    AND json_extract(json,'$.raster.role')='composite'`);
}
export function p2SemanticSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false, activateRequestFamily = false) {
  if(activateRequestFamily)assertEditorSchema18Ready();
  const capability = 'p2-request-adoption-adapters-v1';
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 17) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=17').get();
    if (!row || JSON.parse(String(row.receipt)).capability !== capability) throw new StoreError('CORRUPT_STORE');
    candidatePreservationIndex(db);
    return;
  }
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== 16) throw new StoreError('CORRUPT_STORE');
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  let compatibleExecutable:string|Schema16MaintenancePacket = !fresh&&process.platform==='linux'?installedSchema16Maintenance(root):'5650326b623d4aa2080772307708aa9f1854aa52';
  const backup = fresh ? null : `schema16-backup-${randomUUID()}.sqlite`;
  const retainedDirectories = ['objects','staging','uploads','portable','backend-transport','raster-work'];
  const retainedDirectoryCopies: Record<string, string> = {};
  const retainedFiles: {path: string; bytes: string; hash: string}[] = [];
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const sourceDirectories: string[] = [], sourceFiles: {relative: string; identity: ReturnType<typeof assertPrivate>}[] = [];
    let mutableBytes = 0n;
    const inventory = (relative: string) => {
      const path = join(root, relative); assertPrivate(path, true); sourceDirectories.push(relative);
      for (const entry of readdirSync(path, {withFileTypes:true})) {
        const child = join(relative, entry.name);
        if (entry.isDirectory()) inventory(child);
        else { const identity = assertPrivate(join(root, child), false); mutableBytes += BigInt(identity.size); sourceFiles.push({relative:child,identity}); }
      }
    };
    for (const directory of retainedDirectories.slice(1)) {
      try { assertPrivate(join(root,directory), true); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      inventory(directory); retainedDirectoryCopies[directory] = `${backup}.files/${directory}`;
    }
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const executableBytes=typeof compatibleExecutable==='string'?0n:schema16MaintenanceFiles(compatibleExecutable).reduce((total,file)=>total+BigInt(file.byteLength),0n);
    const total = size + mutableBytes + executableBytes;
    const fs = statfsSync(root, { bigint: true }), required = total + (total+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('p2-semantic-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('p2-semantic-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 16) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    // Mutable upload/preparation/evidence paths may be renamed or extended by
    // normal work. Preserve independent bytes instead of trusting pathname pins.
    const filesRoot = join(root, `${backup}.files`); privateDirectory(filesRoot);
    for (const relative of sourceDirectories) privateDirectory(join(filesRoot, relative));
    const block = Buffer.alloc(1048576);
    for (const source of sourceFiles) {
      const sourcePath = join(root,source.relative), targetPath = join(filesRoot,source.relative);
      const input = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW); let output: number | undefined;
      const hash = createHash('sha256'); let copied = 0;
      try {
        if (!sameFile(source.identity,fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
        output = privateFile(targetPath);
        for (;;) {
          const n = readSync(input,block); if (!n) break; hash.update(block.subarray(0,n)); copied += n;
          let written = 0; while (written<n) { const next = writeSync(output,block,written,n-written,null); if (!next) throw new StoreError('STORAGE_FAILURE'); written += next; }
        }
        fsyncSync(output);
        const after = assertPrivate(sourcePath,false);
        if (!sameFile(source.identity,after) || source.identity.size!==copied || source.identity.size!==after.size || source.identity.mtimeMs!==after.mtimeMs || source.identity.ctimeMs!==after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
      } finally { closeSync(input); if (output!==undefined) closeSync(output); }
      const saved = fileProof(targetPath), expectedHash = `sha256:${hash.digest('hex')}`;
      if (saved.hash!==expectedHash || saved.identity.size!==copied) throw new StoreError('CORRUPT_STORE');
      proofs.push(saved); retainedFiles.push({path:join(`${backup}.files`,source.relative),bytes:String(copied),hash:expectedHash});
    }
    for (const relative of [...sourceDirectories].reverse()) syncDirectory(join(filesRoot,relative));
    if(typeof compatibleExecutable!=='string'){
      compatibleExecutable=copySchema16Maintenance(compatibleExecutable,join(filesRoot,'rollback-executable'));
      for(const file of schema16MaintenanceFiles(compatibleExecutable)){
        const saved=fileProof(file.path);proofs.push(saved);retainedFiles.push({path:join(`${backup}.files`,'rollback-executable',file.path.slice(file.path.lastIndexOf(sep)+1)),bytes:file.byteLength,hash:file.hash});
      }
    }
    syncDirectory(filesRoot);
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 16,
        compatibleExecutable, ...(typeof compatibleExecutable==='string'?{}:{rollbackAuthority:'schema16-linux-maintenance-1',historicalReleaseUnchanged:false}), manifest, retainedDirectories, retainedDirectoryCopies, retainedFiles, originalRoot:root,
        recovery: typeof compatibleExecutable==='string'?'Stop the writer and preserve the upgraded root by moving it aside. Restore into a new owner-only directory at originalRoot, retaining that exact canonical path because schema16 stores absolute cleanup paths. Copy the backup database unchanged, copy the shared objects directory from the preserved root, and restore each mutable directory from retainedDirectoryCopies. Verify backupHash and every retainedFiles hash before opening only the named compatible executable. Keep the preserved upgraded root and backup evidence unchanged.':'Stop the writer and keep the upgraded root and all backup evidence unchanged. Restore the verified schema16 database and exact mutable directory copies into a new private root at originalRoot. The compatibleExecutable is the separately qualified schema16-linux-raster-maintenance-1 Linux packet, not the historical Git release. Restore or relocate every retained executable source, compiled archive and receipt from the backup.files/rollback-executable directory; verify every file hash, the full path-erased packet pin, platform and source identity, and the actual fresh-restore/native/pixel/replay receipt. Dispatch only this known maintenance contract with the Linux maintenance recovery tooling; reject unknown kinds. Execute only its verified fresh restored runtime. Retain the preserved upgraded root.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('p2-semantic-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // All original rows, pending command identities and bytes remain unchanged.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (17,?)').run(canonical({ from:16, to:17, capability,
      strategy:typeof compatibleExecutable==='string'?'semantic-version-verified-backup-transactional-activation':'semantic-version-verified-linux-maintenance-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? { ...(typeof compatibleExecutable==='string'?{}:{kind:'schema16-maintenance-executable-packet',storageVersion:16}), compatibleExecutable, originalRoot:root } : null }));
    db.exec('CREATE TABLE candidate_adoption_evidence (document_id TEXT NOT NULL, attempt_id TEXT NOT NULL, PRIMARY KEY(document_id,attempt_id)) STRICT');
    db.exec('CREATE TABLE candidate_asset_evidence (asset_id TEXT NOT NULL, manifest_hash TEXT NOT NULL, attempt_id TEXT NOT NULL, PRIMARY KEY(asset_id,attempt_id)) STRICT');
    candidatePreservationIndex(db);
    if (backup) {
      // Include objects already queued for deletion, as well as live roots. The
      // independent backup still owns their exact pre-upgrade state.
      const pinObject = db.prepare('INSERT OR IGNORE INTO deletion_backup_pins VALUES (?)');
      for (const row of db.prepare('SELECT hash FROM objects').iterate()) {
        const hash = String(row.hash); if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw new StoreError('CORRUPT_STORE');
        try { assertPrivate(join(root,'objects','sha256',hash.slice(7,9),hash.slice(7)),false); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
          if (db.prepare("SELECT 1 FROM deletion_objects WHERE hash=? AND state IN ('unlinking','freed') LIMIT 1").get(hash)) continue;
          throw new StoreError('MISSING_OBJECT');
        }
        pinObject.run(hash);
      }
      const pinFile = db.prepare('INSERT OR IGNORE INTO deletion_backup_files VALUES (?)');
      const pinDirectory = (path: string) => {
        assertPrivate(path, true);
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const child = join(path, entry.name);
          if (entry.isDirectory()) pinDirectory(child);
          else { assertPrivate(child, false); pinFile.run(child); }
        }
      };
      for (const directory of retainedDirectories.slice(1)) {
        const path = join(root, directory);
        try { assertPrivate(path, true); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        pinDirectory(path);
      }
    }
    // One activation for readers originating at <=16: a crash must not strand
    // their root at 17 and demand an executable that never owned the root.
    if(activateRequestFamily){editorSchema18Tables(db);db.prepare('INSERT INTO schema_migrations VALUES (18,?)').run(canonical({
      from:17,to:18,...editorCapabilityReceipt(),
      strategy:typeof compatibleExecutable==='string'?'semantic-version-inherit-verified-schema16-backup-atomic-activation':'semantic-version-inherit-verified-linux16-maintenance-backup-atomic-activation',backup,backupHash,manifestFile,manifest,
      rollback:backup?{kind:typeof compatibleExecutable==='string'?'inherited-schema-migration':'inherited-linux-maintenance-schema-migration',storageVersion:16,migrationVersion:17,compatibleExecutable,originalRoot:root,manifestHash:proofs.find(proof=>proof.path===join(root,manifestFile!))!.hash}:null,
    }));}
    db.exec(activateRequestFamily?'PRAGMA user_version=18':'PRAGMA user_version=17');
    barrier('p2-semantic-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('p2-semantic-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

// V45 changes persisted semantic contracts without changing any V4 record.
export function requestFamilySchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  assertEditorSchema18Ready();
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 18) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=18').get();
    assertEditorSchema18Receipt(row ? JSON.parse(String(row.receipt)) : null);
    return;
  }
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== 17) throw new StoreError('CORRUPT_STORE');
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  if (!fresh) assertRequestFamilyMigrationReady(17,root);
  let compatibleExecutable = fresh?null:requestFamilyInstalledPacket(root);
  const backup = fresh ? null : `schema17-backup-${randomUUID()}.sqlite`;
  const retainedDirectories = ['objects','staging','uploads','portable','backend-transport','raster-work'];
  const retainedDirectoryCopies: Record<string, string> = {};
  const retainedFiles: {path: string; bytes: string; hash: string}[] = [];
  const manifest: Record<string, unknown> = {};
  let backupHash: string | null = null;
  let manifestFile: string | null = null;
  const fileProof = (path: string) => {
    const identity = assertPrivate(path, false), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), block = Buffer.alloc(1048576);
    try {
      if (!sameFile(identity, fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
      for (;;) { const n = readSync(input, block); if (!n) break; hash.update(block.subarray(0,n)); }
      const after = assertPrivate(path, false);
      if (!sameFile(identity, after) || identity.size !== after.size || identity.mtimeMs !== after.mtimeMs || identity.ctimeMs !== after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
    } finally { closeSync(input); }
    return { path, identity, hash: `sha256:${hash.digest('hex')}` };
  };
  const proofs: ReturnType<typeof fileProof>[] = [];
  if (backup) {
    const sourceDirectories: string[] = [], sourceFiles: {relative: string; identity: ReturnType<typeof assertPrivate>}[] = [];
    let mutableBytes = 0n;
    const inventory = (relative: string) => {
      const path = join(root, relative); assertPrivate(path, true); sourceDirectories.push(relative);
      for (const entry of readdirSync(path, {withFileTypes:true})) {
        const child = join(relative, entry.name);
        if (entry.isDirectory()) inventory(child);
        else { const identity = assertPrivate(join(root, child), false); mutableBytes += BigInt(identity.size); sourceFiles.push({relative:child,identity}); }
      }
    };
    for (const directory of retainedDirectories.slice(1)) {
      try { assertPrivate(join(root,directory), true); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      inventory(directory); retainedDirectoryCopies[directory] = `${backup}.files/${directory}`;
    }
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const executableBytes=requestFamilyPacketFiles(compatibleExecutable!).reduce((total,file)=>total+BigInt(file.byteLength),0n);
    const total = size + mutableBytes + executableBytes;
    const fs = statfsSync(root, { bigint: true }), required = total + (total+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('request-family-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('request-family-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 17) throw new StoreError('CORRUPT_STORE');
      for (const table of tables) {
        const before = digest(db, table);
        if (canonical(before) !== canonical(digest(saved, table))) throw new StoreError('CORRUPT_STORE');
        manifest[table] = before;
      }
      const sql = (database: DatabaseSync) => database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      if (canonical(sql(db)) !== canonical(sql(saved))) throw new StoreError('CORRUPT_STORE');
      manifest.sqlite_schema = hashBytes(canonical(sql(saved)));
    } finally { saved.close(); }
    const fd = privateFile(path); try { fsyncSync(fd); } finally { closeSync(fd); }
    const proof = fileProof(path); proofs.push(proof); backupHash = proof.hash;
    // Mutable upload/preparation/evidence paths may be renamed or extended by
    // normal work. Preserve independent bytes instead of trusting pathname pins.
    const filesRoot = join(root, `${backup}.files`); privateDirectory(filesRoot);
    for (const relative of sourceDirectories) privateDirectory(join(filesRoot, relative));
    const block = Buffer.alloc(1048576);
    for (const source of sourceFiles) {
      const sourcePath = join(root,source.relative), targetPath = join(filesRoot,source.relative);
      const input = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW); let output: number | undefined;
      const hash = createHash('sha256'); let copied = 0;
      try {
        if (!sameFile(source.identity,fstatSync(input))) throw new StoreError('ROOT_UNSAFE');
        output = privateFile(targetPath);
        for (;;) {
          const n = readSync(input,block); if (!n) break; hash.update(block.subarray(0,n)); copied += n;
          let written = 0; while (written<n) { const next = writeSync(output,block,written,n-written,null); if (!next) throw new StoreError('STORAGE_FAILURE'); written += next; }
        }
        fsyncSync(output);
        const after = assertPrivate(sourcePath,false);
        if (!sameFile(source.identity,after) || source.identity.size!==copied || source.identity.size!==after.size || source.identity.mtimeMs!==after.mtimeMs || source.identity.ctimeMs!==after.ctimeMs) throw new StoreError('ROOT_UNSAFE');
      } finally { closeSync(input); if (output!==undefined) closeSync(output); }
      const saved = fileProof(targetPath), expectedHash = `sha256:${hash.digest('hex')}`;
      if (saved.hash!==expectedHash || saved.identity.size!==copied) throw new StoreError('CORRUPT_STORE');
      proofs.push(saved); retainedFiles.push({path:join(`${backup}.files`,source.relative),bytes:String(copied),hash:expectedHash});
    }
    compatibleExecutable=copyRequestFamilyPacket(compatibleExecutable!,join(filesRoot,'rollback-executable'));
    for(const file of requestFamilyPacketFiles(compatibleExecutable)){
      proofs.push(fileProof(file.path));
      retainedFiles.push({path:join(`${backup}.files`,'rollback-executable',file.path.slice(file.path.lastIndexOf('/')+1)),bytes:file.byteLength,hash:file.hash});
    }
    for (const relative of [...sourceDirectories].reverse()) syncDirectory(join(filesRoot,relative));
    syncDirectory(filesRoot);
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 17,
        compatibleExecutable, manifest, retainedDirectories, retainedDirectoryCopies, retainedFiles, originalRoot:root,
        recovery: 'Stop the writer and preserve the upgraded root by moving it aside. Restore into a new owner-only directory at originalRoot, retaining that exact canonical path because schema17 stores absolute cleanup paths. Copy the backup database unchanged, copy the shared objects directory from the preserved root, and restore each mutable directory from retainedDirectoryCopies. Verify backupHash and every retainedFiles hash before opening only the typed compatibleExecutable packet. Verify its fresh-restore receipt and all source/compiled archive identities; its sealed artifacts are retained under the rollback-executable directory. Keep the preserved upgraded root and backup evidence unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('request-family-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // All original rows, pending command identities and bytes remain unchanged.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    editorSchema18Tables(db);
    db.prepare('INSERT INTO schema_migrations VALUES (18,?)').run(canonical({ from:17, to:18, ...editorCapabilityReceipt(),
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? {kind:'schema17-executable-packet',storageVersion:17,compatibleExecutable, originalRoot:root } : null }));
    if (backup) {
      // Include objects already queued for deletion, as well as live roots. The
      // independent backup still owns their exact pre-upgrade state.
      const pinObject = db.prepare('INSERT OR IGNORE INTO deletion_backup_pins VALUES (?)');
      for (const row of db.prepare('SELECT hash FROM objects').iterate()) {
        const hash = String(row.hash); if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw new StoreError('CORRUPT_STORE');
        try { assertPrivate(join(root,'objects','sha256',hash.slice(7,9),hash.slice(7)),false); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
          if (db.prepare("SELECT 1 FROM deletion_objects WHERE hash=? AND state IN ('unlinking','freed') LIMIT 1").get(hash)) continue;
          throw new StoreError('MISSING_OBJECT');
        }
        pinObject.run(hash);
      }
      const pinFile = db.prepare('INSERT OR IGNORE INTO deletion_backup_files VALUES (?)');
      const pinDirectory = (path: string) => {
        assertPrivate(path, true);
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const child = join(path, entry.name);
          if (entry.isDirectory()) pinDirectory(child);
          else { assertPrivate(child, false); pinFile.run(child); }
        }
      };
      for (const directory of retainedDirectories.slice(1)) {
        const path = join(root, directory);
        try { assertPrivate(path, true); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        pinDirectory(path);
      }
    }
    db.exec('PRAGMA user_version=18');
    barrier('request-family-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('request-family-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

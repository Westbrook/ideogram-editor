import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,fsyncSync,openSync,readSync,writeSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import {canonical,hashBytes,isId} from './canonical.js';
import {assertComponents,assertPrivate,privateDirectory,privateFile,sameFile,syncDirectory} from './files.js';
import {StoreError} from './errors.js';
import {schema16MaintenanceExecutablePin,type Schema16MaintenanceExecutablePin} from './platform-authority.js';

type SealedFile={path:string;hash:string;byteLength:string};
export type Schema16MaintenancePacket={
  kind:'schema16-maintenance-executable-packet-1';storageVersion:16;packetId:string;
  compatibilityContract:'schema16-linux-raster-maintenance-1';historicalBase:'5650326b623d4aa2080772307708aa9f1854aa52';
  maintenancePatchHash:'sha256:77f7fddc26a02bc9c4e613de72f47d213fa58bee9846ff84717cdece58214958';sourceIdentity:string;
  sourceArchive:SealedFile;sourceManifest:SealedFile;
  compiler:{name:'typescript';version:'7.0.2';identity:string};toolchain:{node:'26.10.0';npm:'12.1.0';identity:string};
  dependencies:{lockfileHash:string;vendorManifestHash:string;identity:string};native:{profileHash:string;artifactManifestHash:string};
  platform:{os:'linux';arch:'x64'|'arm64';identity:string};
  compiledClosures:{name:string;archive:SealedFile;manifest:SealedFile}[];
  verifiedFreshRestore:{receipt:SealedFile;sourceArchiveHash:string;compiledClosureHash:string;result:'verified'};
};
const digest=(value:unknown):value is string=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);
function fail():never{throw new StoreError('CORRUPT_STORE');}
function keys(value:unknown,expected:string):asserts value is Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==expected)fail();
}
function fileShape(value:unknown):asserts value is SealedFile{
  keys(value,'byteLength,hash,path');
  if(typeof value.path!=='string'||!isAbsolute(value.path)||!digest(value.hash)||typeof value.byteLength!=='string'||!/^(0|[1-9][0-9]*)$/.test(value.byteLength)||BigInt(value.byteLength)>BigInt(Number.MAX_SAFE_INTEGER))fail();
}
export function schema16MaintenanceFiles(packet:Schema16MaintenancePacket):SealedFile[]{
  return [packet.sourceArchive,packet.sourceManifest,...packet.compiledClosures.flatMap(row=>[row.archive,row.manifest]),packet.verifiedFreshRestore.receipt];
}
export function schema16MaintenanceFileProof(file:SealedFile):void{
  fileShape(file);assertComponents(dirname(file.path));const before=assertPrivate(file.path,false);
  const hash=createHash('sha256');let total=0n;const fd=openSync(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const block=Buffer.alloc(1048576);if(!sameFile(before,fstatSync(fd)))throw new StoreError('ROOT_UNSAFE');for(;;){const n=readSync(fd,block);if(!n)break;total+=BigInt(n);if(total>BigInt(file.byteLength))throw new StoreError('CORRUPT_OBJECT');hash.update(block.subarray(0,n));}}
  finally{closeSync(fd);}
  const after=assertPrivate(file.path,false);
  if(!sameFile(before,after)||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||total!==BigInt(file.byteLength)||'sha256:'+hash.digest('hex')!==file.hash)throw new StoreError('CORRUPT_OBJECT');
}
function json(file:SealedFile):unknown{
  schema16MaintenanceFileProof(file);if(BigInt(file.byteLength)>65536n)fail();
  const bytes=Buffer.alloc(Number(file.byteLength)),fd=openSync(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{let offset=0;while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,null);if(!count)throw new StoreError('CORRUPT_OBJECT');offset+=count;}}
  finally{closeSync(fd);}
  if(hashBytes(bytes)!==file.hash)throw new StoreError('CORRUPT_OBJECT');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;}catch{throw new StoreError('CORRUPT_OBJECT');}
}
function pathless(value:unknown):unknown{
  if(!value||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(pathless);
  const record=value as Record<string,unknown>;
  if(Object.keys(record).sort().join(',')==='byteLength,hash,path')return {hash:record.hash,byteLength:record.byteLength};
  return Object.fromEntries(Object.entries(record).map(([key,child])=>[key,pathless(child)]));
}
export function schema16MaintenanceIdentity(packet:Schema16MaintenancePacket):string{return hashBytes(canonical(pathless(packet)));}
function packetShape(value:unknown):asserts value is Schema16MaintenancePacket{
  keys(value,'compatibilityContract,compiledClosures,compiler,dependencies,historicalBase,kind,maintenancePatchHash,native,packetId,platform,sourceArchive,sourceIdentity,sourceManifest,storageVersion,toolchain,verifiedFreshRestore');
  if(value.kind!=='schema16-maintenance-executable-packet-1'||value.storageVersion!==16||value.compatibilityContract!=='schema16-linux-raster-maintenance-1'||value.historicalBase!=='5650326b623d4aa2080772307708aa9f1854aa52'||value.maintenancePatchHash!=='sha256:77f7fddc26a02bc9c4e613de72f47d213fa58bee9846ff84717cdece58214958'||!digest(value.sourceIdentity)||!isId(value.packetId))fail();
  keys(value.compiler,'identity,name,version');keys(value.toolchain,'identity,node,npm');keys(value.dependencies,'identity,lockfileHash,vendorManifestHash');keys(value.native,'artifactManifestHash,profileHash');keys(value.platform,'arch,identity,os');keys(value.verifiedFreshRestore,'compiledClosureHash,receipt,result,sourceArchiveHash');
  if(value.compiler.name!=='typescript'||value.compiler.version!=='7.0.2'||value.toolchain.node!=='26.10.0'||value.toolchain.npm!=='12.1.0'||value.platform.os!=='linux'||!['x64','arm64'].includes(String(value.platform.arch))||value.platform.os!==process.platform||value.platform.arch!==process.arch)fail();
  for(const field of [value.compiler.identity,value.toolchain.identity,value.dependencies.identity,value.dependencies.lockfileHash,value.dependencies.vendorManifestHash,value.native.profileHash,value.native.artifactManifestHash,value.platform.identity])if(!digest(field))fail();
  if(!Array.isArray(value.compiledClosures)||value.compiledClosures.length<2||value.compiledClosures.length>32)fail();
  const names=new Set<string>();
  for(const closure of value.compiledClosures){keys(closure,'archive,manifest,name');if(!isId(closure.name)||names.has(closure.name))fail();names.add(closure.name);fileShape(closure.archive);fileShape(closure.manifest);}
  if(!names.has('application-runtime')||!names.has('qualification-evidence'))fail();
  fileShape(value.sourceArchive);fileShape(value.sourceManifest);fileShape(value.verifiedFreshRestore.receipt);
  if(value.verifiedFreshRestore.result!=='verified'||value.verifiedFreshRestore.sourceArchiveHash!==value.sourceArchive.hash||!digest(value.verifiedFreshRestore.compiledClosureHash))fail();
}
function verify(packet:Schema16MaintenancePacket):Schema16MaintenancePacket{
  packetShape(packet);
  const proof=packet.verifiedFreshRestore,closures=packet.compiledClosures.map(row=>({name:row.name,archive:{hash:row.archive.hash,byteLength:row.archive.byteLength},manifest:{hash:row.manifest.hash,byteLength:row.manifest.byteLength}}));
  if(hashBytes(canonical(closures))!==proof.compiledClosureHash)fail();
  for(const file of schema16MaintenanceFiles(packet))schema16MaintenanceFileProof(file);
  const receipt=json(proof.receipt);keys(receipt,'checks,compiledClosureHash,dependencyIdentity,evidence,kind,nativeProfileHash,platformIdentity,result,sourceArchiveHash,storageVersion,toolchainIdentity');
  if(receipt.kind!=='schema16-maintenance-fresh-restore-1'||receipt.storageVersion!==16||receipt.result!=='verified'||receipt.sourceArchiveHash!==packet.sourceArchive.hash||receipt.compiledClosureHash!==proof.compiledClosureHash||receipt.toolchainIdentity!==packet.toolchain.identity||receipt.dependencyIdentity!==packet.dependencies.identity||receipt.nativeProfileHash!==packet.native.profileHash||receipt.platformIdentity!==packet.platform.identity)fail();
  if(canonical(receipt.checks)!==canonical({freshRestore:true,openExistingSchema16:true,replayByteIdentity:true,nativeRasterInitialized:true,independentPixelGoldens:true,futureSchemaRefusal:true,networkEffects:0}))fail();
  return packet;
}
/** Read-only prerequisite. Empty/wrong-platform authority refuses before any
 * writable owned-store connection or writer epoch update is possible. */
export function installedSchema16Maintenance(root:string,pin:Schema16MaintenanceExecutablePin|null=schema16MaintenanceExecutablePin()):Schema16MaintenancePacket{
  if(pin===null||pin.kind!=='schema16-maintenance-executable-pin-1'||pin.storageVersion!==16||pin.compatibilityContract!=='schema16-linux-raster-maintenance-1'||pin.historicalBase!=='5650326b623d4aa2080772307708aa9f1854aa52'||pin.maintenancePatchHash!=='sha256:77f7fddc26a02bc9c4e613de72f47d213fa58bee9846ff84717cdece58214958'||!isId(pin.packetId)||!digest(pin.identityHash)||!digest(pin.sourceIdentity)||!digest(pin.platform.identity)||pin.platform.os!=='linux'||pin.platform.os!==process.platform||pin.platform.arch!==process.arch)throw new StoreError('UNSUPPORTED_STORAGE');
  const directory=join(root,'rollback-executables',pin.packetId),path=join(directory,'packet.json');assertComponents(directory);assertPrivate(directory,true);
  const before=assertPrivate(path,false);if(before.size>65536)fail();
  const bytes=Buffer.alloc(before.size),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{if(!sameFile(before,fstatSync(fd)))throw new StoreError('ROOT_UNSAFE');let offset=0;while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,null);if(!count)fail();offset+=count;}}
  finally{closeSync(fd);}
  const packet=json({path,hash:hashBytes(bytes),byteLength:String(bytes.length)});packetShape(packet);
  if(packet.packetId!==pin.packetId||schema16MaintenanceIdentity(packet)!==pin.identityHash||packet.sourceIdentity!==pin.sourceIdentity||canonical(packet.platform)!==canonical(pin.platform))fail();
  for(const file of schema16MaintenanceFiles(packet))if(dirname(file.path)!==directory)throw new StoreError('ROOT_UNSAFE');
  return verify(packet);
}
export function copySchema16Maintenance(packet:Schema16MaintenancePacket,destination:string):Schema16MaintenancePacket{
  verify(packet);privateDirectory(destination);let index=0;
  const copy=(source:SealedFile):SealedFile=>{
    schema16MaintenanceFileProof(source);const target={...source,path:join(destination,String(index++).padStart(3,'0')+'.sealed')};
    const before=assertPrivate(source.path,false),input=openSync(source.path,constants.O_RDONLY|constants.O_NOFOLLOW);let copied=0n;
    try{const block=Buffer.alloc(1048576),output=privateFile(target.path);
      try{if(!sameFile(before,fstatSync(input)))throw new StoreError('ROOT_UNSAFE');for(;;){const count=readSync(input,block);if(!count)break;copied+=BigInt(count);if(copied>BigInt(source.byteLength))throw new StoreError('CORRUPT_OBJECT');let offset=0;while(offset<count){const written=writeSync(output,block,offset,count-offset,null);if(!written)throw new StoreError('STORAGE_FAILURE');offset+=written;}}if(copied!==BigInt(source.byteLength)||!sameFile(before,fstatSync(input)))throw new StoreError('CORRUPT_OBJECT');fsyncSync(output);}
      finally{closeSync(output);}
    }finally{closeSync(input);}
    schema16MaintenanceFileProof(source);schema16MaintenanceFileProof(target);return target;
  };
  const retained={...packet,sourceArchive:copy(packet.sourceArchive),sourceManifest:copy(packet.sourceManifest),compiledClosures:packet.compiledClosures.map(row=>({...row,archive:copy(row.archive),manifest:copy(row.manifest)})),verifiedFreshRestore:{...packet.verifiedFreshRestore,receipt:copy(packet.verifiedFreshRestore.receipt)}};
  syncDirectory(destination);if(schema16MaintenanceIdentity(retained)!==schema16MaintenanceIdentity(packet))fail();return verify(retained);
}

// Additive schema19 successor. Frozen schema18 and authentic17 lineage stay in schema.ts.
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,fsyncSync,statfsSync,openSync,readSync,writeSync,writeFileSync,constants,fstatSync,readdirSync} from 'node:fs';
import {join,isAbsolute,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {canonical,hashBytes,isId} from './canonical.js';
import {privateFile,privateDirectory,syncDirectory,assertPrivate,assertComponents,inspectTree,sameFile} from './files.js';
import {StoreError} from './errors.js';
import type {Barrier} from './objects.js';
import {freezeRollbackAuthorities,selectRollbackExecutable} from './platform-authority.js';
import {assertEditorSchema18Receipt,EDITOR_SCHEMA18_CAPABILITY_HASH} from './schema.js';

export const COMPOSITION_TEXT_SCHEMA19_CAPABILITY_MANIFEST={kind:'editor-capability-manifest-1',storageVersion:19,projectionSchema:9,assetProjectionSchema:3,completePortableFormat:12,recoveryPortableFormat:11,previousCapabilityHash:'sha256:c2eb7167875862e82da5f86dc52238001c09852a25c62d2f1bf9be9a2c3f0752',capabilities:['composition-text-export-v1']} as const;
export const COMPOSITION_TEXT_SCHEMA19_CAPABILITY_HASH=hashBytes(canonical(COMPOSITION_TEXT_SCHEMA19_CAPABILITY_MANIFEST));
// Root seals this new capability only after exact source review. Never alter18's seal.
export const COMPOSITION_TEXT_SCHEMA19_CAPABILITY_SEAL:string|null="sha256:8ce74d976277554dd43be2ccd549b75658e7d530b3fd341247f05e73fb684a43";
const capability='composition-text-contracts-19-v1';
function refuse(code:string):never{throw new StoreError('UNSUPPORTED_STORAGE',{kind:'fields',issues:[{path:'storage.schemaVersion',code}]});}
export function assertCompositionTextSchema19Ready(seal:string|null=COMPOSITION_TEXT_SCHEMA19_CAPABILITY_SEAL):void{if(seal!==COMPOSITION_TEXT_SCHEMA19_CAPABILITY_HASH)refuse('COMPOSITION_TEXT_SCHEMA19_CAPABILITIES_UNSEALED');}
export function assertCompositionTextSchema19Receipt(receipt:any):void{if(!receipt||receipt.from!==18||receipt.to!==19||receipt.capability!==capability||receipt.capabilityHash!==COMPOSITION_TEXT_SCHEMA19_CAPABILITY_HASH||canonical(receipt.capabilityManifest??null)!==canonical(COMPOSITION_TEXT_SCHEMA19_CAPABILITY_MANIFEST))refuse('COMPOSITION_TEXT_SCHEMA19_CAPABILITY_MISMATCH');}
function capabilityReceipt(){assertCompositionTextSchema19Ready();return {capability,capabilityManifest:COMPOSITION_TEXT_SCHEMA19_CAPABILITY_MANIFEST,capabilityHash:COMPOSITION_TEXT_SCHEMA19_CAPABILITY_HASH};}

export type CompositionTextSealedFile={path:string;hash:string;byteLength:string};
export type Schema18ExecutablePacket={
  kind:'schema18-executable-packet-1';storageVersion:18;packetId:string;capabilityHash:string;
  sourceArchive:CompositionTextSealedFile;sourceManifest:CompositionTextSealedFile;
  compiler:{name:'typescript';version:string;identity:string};
  toolchain:{node:'26.10.0';npm:'12.1.0';identity:string};
  dependencies:{lockfileHash:string;vendorManifestHash:string;identity:string};
  native:{profileHash:string;artifactManifestHash:string};
  platform:{os:string;arch:string;identity:string};
  compiledClosures:readonly {name:string;archive:CompositionTextSealedFile;manifest:CompositionTextSealedFile}[];
  verifiedFreshRestore:{receipt:CompositionTextSealedFile;sourceArchiveHash:string;compiledClosureHash:string;result:'verified'};
  gitCommit?:string;
};
// A genuine schema18 packet must be captured/restored before existing roots may
// migrate. Null is intentional until root records the actual producer identity;
// an authentic17 packet cannot substitute, and previous backup lineage is kept.
export type Schema18ExecutablePin={kind:'schema18-executable-pin-1';packetId:string;identityHash:string;platform:Schema18ExecutablePacket['platform']};
export const COMPOSITION_TEXT_SCHEMA18_EXECUTABLE: Schema18ExecutablePin | null = {"identityHash":"sha256:e7f1f4673ec28933608843e8c44e8ed70f6009fe63f3a59ac7068f8843933c17","kind":"schema18-executable-pin-1","packetId":"schema18-70cebc189c3b33c34a094678","platform":{"arch":"arm64","identity":"sha256:348d9deb7f48dfe75031343116e784da3266f6b5fe69ef1f02a3db6c2b11b534","os":"darwin"}};
// This declaration is reserved for the separately captured Darwin18 packet.
// Linux authorities stay absent until their own producer and restore proof pass.
export const COMPOSITION_TEXT_SCHEMA18_AUTHORITIES=freezeRollbackAuthorities([
  {os:'darwin',arch:'arm64',pin:COMPOSITION_TEXT_SCHEMA18_EXECUTABLE},
]);
export function compositionTextExecutablePin():Schema18ExecutablePin{
  return selectRollbackExecutable('schema18-executable-pin-1',COMPOSITION_TEXT_SCHEMA18_AUTHORITIES,process.platform,process.arch);
}
const compositionTextDigest=(value:unknown):value is string=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);
function compositionTextFileProof(file:CompositionTextSealedFile):void {
  if(!isAbsolute(file.path)||!compositionTextDigest(file.hash)||!/^(0|[1-9][0-9]*)$/.test(file.byteLength)||BigInt(file.byteLength)>BigInt(Number.MAX_SAFE_INTEGER))throw new StoreError('CORRUPT_STORE');
  assertComponents(dirname(file.path));const before=assertPrivate(file.path,false),input=openSync(file.path,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256'),block=Buffer.alloc(1048576);let total=0n;
  try{if(!sameFile(before,fstatSync(input)))throw new StoreError('ROOT_UNSAFE');for(;;){const count=readSync(input,block);if(!count)break;total+=BigInt(count);hash.update(block.subarray(0,count));}}
  finally{closeSync(input);}
  const after=assertPrivate(file.path,false);
  if(!sameFile(before,after)||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||total!==BigInt(file.byteLength)||'sha256:'+hash.digest('hex')!==file.hash)throw new StoreError('CORRUPT_OBJECT');
}
function compositionTextPacketFiles(packet:Schema18ExecutablePacket):CompositionTextSealedFile[]{return [packet.sourceArchive,packet.sourceManifest,...packet.compiledClosures.flatMap(value=>[value.archive,value.manifest]),packet.verifiedFreshRestore.receipt];}
function compositionTextPacket(packet:Schema18ExecutablePacket|null):Schema18ExecutablePacket {
  if(packet===null)throw new StoreError('UNSUPPORTED_STORAGE',{kind:'fields',issues:[{path:'storage.schemaVersion',code:'COMPOSITION_TEXT_ROLLBACK_EXECUTABLE_REQUIRED'}]});
  if(packet.kind!=='schema18-executable-packet-1'||packet.storageVersion!==18||packet.capabilityHash!==EDITOR_SCHEMA18_CAPABILITY_HASH||!isId(packet.packetId)||packet.compiler.name!=='typescript'||!packet.compiler.version||packet.toolchain.node!=='26.10.0'||packet.toolchain.npm!=='12.1.0'||!packet.platform.os||!packet.platform.arch||packet.gitCommit!==undefined&&!/^[a-f0-9]{40}$/.test(packet.gitCommit)||!packet.compiledClosures.length||packet.compiledClosures.length>32||new Set(packet.compiledClosures.map(value=>value.name)).size!==packet.compiledClosures.length||packet.compiledClosures.some(value=>!isId(value.name)))throw new StoreError('CORRUPT_STORE');
  for(const hash of [packet.compiler.identity,packet.toolchain.identity,packet.dependencies.lockfileHash,packet.dependencies.vendorManifestHash,packet.dependencies.identity,packet.native.profileHash,packet.native.artifactManifestHash,packet.platform.identity])if(!compositionTextDigest(hash))throw new StoreError('CORRUPT_STORE');
  const restore=packet.verifiedFreshRestore,closures=packet.compiledClosures.map(value=>({name:value.name,archive:{hash:value.archive.hash,byteLength:value.archive.byteLength},manifest:{hash:value.manifest.hash,byteLength:value.manifest.byteLength}}));
  if(restore.result!=='verified'||restore.sourceArchiveHash!==packet.sourceArchive.hash||restore.compiledClosureHash!==hashBytes(canonical(closures)))throw new StoreError('CORRUPT_STORE');
  for(const file of compositionTextPacketFiles(packet))compositionTextFileProof(file);
  const receipt=compositionTextJSON(restore.receipt);
  if(receipt.kind!=='schema18-fresh-restore-1'||receipt.storageVersion!==18||receipt.result!=='verified'||receipt.sourceArchiveHash!==restore.sourceArchiveHash||receipt.compiledClosureHash!==restore.compiledClosureHash||receipt.toolchainIdentity!==packet.toolchain.identity||receipt.dependencyIdentity!==packet.dependencies.identity||receipt.nativeProfileHash!==packet.native.profileHash||receipt.platformIdentity!==packet.platform.identity||receipt.checks?.freshRestore!==true||receipt.checks?.openExistingSchema18!==true||receipt.capabilityHash!==packet.capabilityHash||receipt.checks?.refuseFutureSchema19!==true||receipt.checks?.replayByteIdentity!==true||receipt.checks?.networkEffects!==0)throw new StoreError('CORRUPT_STORE');
  return packet;
}
/** Paths are installation locations, never part of the executable identity. */
export function schema18PacketIdentity(packet:Schema18ExecutablePacket):string {
  const content=(value:any):any=>{
    if(!value||typeof value!=='object')return value;
    if(Array.isArray(value))return value.map(content);
    if(Object.keys(value).sort().join(',')==='byteLength,hash,path')return {hash:value.hash,byteLength:value.byteLength};
    return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,content(child)]));
  };return hashBytes(canonical(content(packet)));
}
export function compositionTextInstalledPacket(root:string,pin:Schema18ExecutablePin|null=compositionTextExecutablePin()):Schema18ExecutablePacket {
  if(pin===null)throw new StoreError('UNSUPPORTED_STORAGE',{kind:'fields',issues:[{path:'storage.schemaVersion',code:'COMPOSITION_TEXT_ROLLBACK_EXECUTABLE_REQUIRED'}]});
  if(pin.kind!=='schema18-executable-pin-1'||!isId(pin.packetId)||!compositionTextDigest(pin.identityHash)||!compositionTextDigest(pin.platform.identity)||pin.platform.os!==process.platform||pin.platform.arch!==process.arch)throw new StoreError('UNSUPPORTED_STORAGE');
  const directory=join(root,'rollback-executables',pin.packetId),path=join(directory,'packet.json');
  assertComponents(directory);assertPrivate(directory,true);const stat=assertPrivate(path,false);if(stat.size>65536)throw new StoreError('CORRUPT_STORE');
  const input=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),bytes=Buffer.alloc(stat.size);
  try{if(!sameFile(stat,fstatSync(input)))throw new StoreError('ROOT_UNSAFE');let offset=0;while(offset<bytes.length){const count=readSync(input,bytes,offset,bytes.length-offset,null);if(!count)throw new StoreError('CORRUPT_OBJECT');offset+=count;}}finally{closeSync(input);}
  const descriptor=compositionTextJSON({path,hash:hashBytes(bytes),byteLength:String(bytes.length)}) as Schema18ExecutablePacket;
  if(descriptor.packetId!==pin.packetId||schema18PacketIdentity(descriptor)!==pin.identityHash||canonical(descriptor.platform)!==canonical(pin.platform))throw new StoreError('CORRUPT_STORE');
  // Installer writes fixed private filenames in this exact owned directory.
  // Never follow source-machine paths or an environment/global fallback.
  for(const file of compositionTextPacketFiles(descriptor))if(dirname(file.path)!==directory)throw new StoreError('ROOT_UNSAFE');
  return compositionTextPacket(descriptor);
}
export function assertCompositionTextMigrationReady(version:number,root:string):void {
  if(version>=1&&version<=18)compositionTextInstalledPacket(root);
}
function compositionTextJSON(file:CompositionTextSealedFile):any {
  compositionTextFileProof(file);if(BigInt(file.byteLength)>65536n)throw new StoreError('CORRUPT_STORE');
  const bytes=Buffer.alloc(Number(file.byteLength)),input=openSync(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{let offset=0;while(offset<bytes.length){const count=readSync(input,bytes,offset,bytes.length-offset,null);if(!count)throw new StoreError('CORRUPT_OBJECT');offset+=count;}}
  finally{closeSync(input);}
  if(hashBytes(bytes)!==file.hash)throw new StoreError('CORRUPT_OBJECT');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new StoreError('CORRUPT_OBJECT');}
}

/** Retain executable bytes inside this rollback packet. External producer paths
 * are prerequisites, never the only copies needed to recover this root. */
function copyCompositionTextPacket(packet:Schema18ExecutablePacket,destination:string):Schema18ExecutablePacket {
  privateDirectory(destination);let index=0;
  const copy=(source:CompositionTextSealedFile):CompositionTextSealedFile=>{
    compositionTextFileProof(source);
    const target={...source,path:join(destination,String(index++).padStart(3,'0')+'.sealed')};
    const input=openSync(source.path,constants.O_RDONLY|constants.O_NOFOLLOW),output=privateFile(target.path),block=Buffer.alloc(1048576);
    try{for(;;){const count=readSync(input,block);if(!count)break;let offset=0;while(offset<count){const n=writeSync(output,block,offset,count-offset,null);if(!n)throw new StoreError('STORAGE_FAILURE');offset+=n;}}fsyncSync(output);}
    finally{closeSync(input);closeSync(output);}
    compositionTextFileProof(source);compositionTextFileProof(target);return target;
  };
  const retained={...packet,sourceArchive:copy(packet.sourceArchive),sourceManifest:copy(packet.sourceManifest),compiledClosures:packet.compiledClosures.map(value=>({...value,archive:copy(value.archive),manifest:copy(value.manifest)})),verifiedFreshRestore:{...packet.verifiedFreshRestore,receipt:copy(packet.verifiedFreshRestore.receipt)}};
  syncDirectory(destination);return compositionTextPacket(retained);
}


function digest(db: DatabaseSync, table: string): { hash: string; count: string } {
  const h = createHash('sha256'); let n = 0n;
  const order = db.prepare(`PRAGMA table_info(${table})`).all().length === 1 ? '1' : '1,2';
  for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) { h.update(canonical(row) + '\n'); n++; }
  return { hash: h.digest('hex'), count: String(n) };
}

/** Preserve an exact18 database and its independent mutable/executable closure before adding only the19 receipt. */
export function compositionTextSchema(db: DatabaseSync, root: string, barrier: Barrier, quotaBytes?: string, fresh = false) {
  assertCompositionTextSchema19Ready();
  const version=Number(db.prepare('PRAGMA user_version').get()!.user_version);if(version>19)refuse('USE_MATCHING_EXECUTABLE_OR_VERIFIED_BACKUP');
  if(version===18||version===19){const previous=db.prepare('SELECT receipt FROM schema_migrations WHERE version=18').get();assertEditorSchema18Receipt(previous?JSON.parse(String(previous.receipt)):null);}
  if (version === 19) {
    const row = db.prepare('SELECT receipt FROM schema_migrations WHERE version=19').get();
    assertCompositionTextSchema19Receipt(row ? JSON.parse(String(row.receipt)) : null);
    return;
  }
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== 18) throw new StoreError('CORRUPT_STORE');
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
  if (!fresh) assertCompositionTextMigrationReady(18,root);
  let compatibleExecutable = fresh?null:compositionTextInstalledPacket(root);
  const backup = fresh ? null : `schema18-backup-${randomUUID()}.sqlite`;
  const retainedDirectories = ['objects','staging','uploads','portable','backend-transport','raster-work'];
  const retainedDirectoryCopies: Record<string, string> = {};
  const retainedRootFileCopies:Record<string,string>={};
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
    // Independently preserve prior rollback lineage too. The18 SQLite backup
    // contains these exact historical receipts; moving it to a restored root must
    // not strand their authentic16/17 database, manifest or executable archives.
    for(const entry of readdirSync(root,{withFileTypes:true})){
      const match=/^schema([0-9]+)-backup-[A-Za-z0-9_-]+\.sqlite(?:\.files|\.manifest\.json)?$/.exec(entry.name);
      if(!match||Number(match[1])>=18)continue;
      if(entry.isDirectory())retainedDirectories.push(entry.name);
      else{const identity=assertPrivate(join(root,entry.name),false);mutableBytes+=BigInt(identity.size);sourceFiles.push({relative:entry.name,identity});retainedRootFileCopies[entry.name]=`${backup}.files/${entry.name}`;}
    }
    for (const directory of retainedDirectories.slice(1)) {
      try { assertPrivate(join(root,directory), true); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      inventory(directory); retainedDirectoryCopies[directory] = `${backup}.files/${directory}`;
    }
    const size = BigInt(Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size));
    const executableBytes=compositionTextPacketFiles(compatibleExecutable!).reduce((total,file)=>total+BigInt(file.byteLength),0n);
    const total = size + mutableBytes + executableBytes;
    const fs = statfsSync(root, { bigint: true }), required = total + (total+3n)/4n + 1073741824n + 67108864n;
    if (fs.bavail*fs.bsize < required || (fs.blocks-fs.bavail)*10n >= fs.blocks*9n ||
        (quotaBytes && inspectTree(root)+required > BigInt(quotaBytes))) throw new StoreError('CAPACITY');
    barrier('composition-text-schema-before-backup');
    const path = join(root, backup);
    closeSync(privateFile(path));
    db.prepare('VACUUM INTO ?').run(path); assertPrivate(path, false);
    barrier('composition-text-schema-backup-written');
    const saved = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      if (saved.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          saved.prepare('PRAGMA user_version').get()!.user_version !== 18) throw new StoreError('CORRUPT_STORE');
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
    compatibleExecutable=copyCompositionTextPacket(compatibleExecutable!,join(filesRoot,'rollback-executable'));
    for(const file of compositionTextPacketFiles(compatibleExecutable)){
      proofs.push(fileProof(file.path));
      retainedFiles.push({path:join(`${backup}.files`,'rollback-executable',file.path.slice(file.path.lastIndexOf('/')+1)),bytes:file.byteLength,hash:file.hash});
    }
    for (const relative of [...sourceDirectories].reverse()) syncDirectory(join(filesRoot,relative));
    syncDirectory(filesRoot);
    manifestFile = `${backup}.manifest.json`;
    const out = privateFile(join(root, manifestFile));
    try {
      writeFileSync(out, canonical({ schemaVersion: 1, backup, backupHash, storageVersion: 18,
        compatibleExecutable, manifest, retainedDirectories, retainedDirectoryCopies, retainedRootFileCopies, retainedFiles, originalRoot:root,
        recovery: 'Stop the writer and preserve the upgraded root by moving it aside. Restore into a new owner-only directory at originalRoot, retaining that exact canonical path because schema18 stores absolute cleanup paths. Copy the backup database unchanged, copy the shared objects directory from the preserved root, and restore every mutable or inherited rollback directory from retainedDirectoryCopies plus every inherited root file from retainedRootFileCopies. Verify backupHash and every retainedFiles hash before opening only the typed compatibleExecutable packet. Verify its fresh-restore receipt and all source/compiled archive identities; its sealed artifacts are retained under the rollback-executable directory. Keep the preserved upgraded root and backup evidence unchanged.' }));
      fsyncSync(out);
    } finally { closeSync(out); }
    proofs.push(fileProof(join(root, manifestFile)));
    syncDirectory(root);
    barrier('composition-text-schema-backup-verified');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    // All original rows, pending command identities and bytes remain unchanged.
    for (const table of tables) if (backup && canonical(manifest[table]) !== canonical(digest(db, table))) throw new StoreError('CORRUPT_STORE');
    db.prepare('INSERT INTO schema_migrations VALUES (19,?)').run(canonical({ from:18, to:19, ...capabilityReceipt(),
      strategy:'semantic-version-verified-backup-transactional-activation', backup, backupHash, manifestFile, manifest,
      rollback: backup ? {kind:'schema18-executable-packet',storageVersion:18,compatibleExecutable, originalRoot:root } : null }));
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
      for(const relative of Object.keys(retainedRootFileCopies)){assertPrivate(join(root,relative),false);pinFile.run(join(root,relative));}
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
    db.exec('PRAGMA user_version=19');
    barrier('composition-text-schema-before-activation');
    for (const proof of proofs) {
      const current = fileProof(proof.path);
      if (!sameFile(current.identity, proof.identity) || current.hash !== proof.hash) throw new StoreError('CORRUPT_STORE');
    }
    db.exec('COMMIT'); syncDirectory(root);
    barrier('composition-text-schema-after-activation');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
